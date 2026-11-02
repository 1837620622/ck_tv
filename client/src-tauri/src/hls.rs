//! HLS 播放列表（.m3u8）解析和分片解密，只包含下载需要的部分：
//! 主播放列表选最高码率；分片可以是明文，也可以是 AES-128 加密。
//! fMP4 和字节范围分片暂不支持，遇到时直接说明原因，不生成残缺的文件。

use reqwest::Url;

#[derive(Debug, PartialEq)]
pub enum Playlist {
    /// 主播放列表：列出各个画质
    Master(Vec<Variant>),
    /// 媒体播放列表：按顺序排列的分片
    Media(Vec<Segment>),
}

#[derive(Debug, PartialEq)]
pub struct Variant {
    pub bandwidth: u64,
    pub uri: Url,
}

#[derive(Debug, PartialEq, Clone)]
pub struct Segment {
    pub uri: Url,
    /// 这个分片使用的加密信息；None 表示明文
    pub key: Option<SegmentKey>,
    /// 分片序号，没有指定 IV 时用它生成 IV
    pub sequence: u64,
    /// 分片时长（秒），来自 #EXTINF，生成本地播放列表时要用
    pub duration: f64,
}

#[derive(Debug, PartialEq, Clone)]
pub struct SegmentKey {
    pub uri: Url,
    pub iv: Option<[u8; 16]>,
}

pub fn parse(text: &str, base: &Url) -> Result<Playlist, String> {
    if !text.trim_start().starts_with("#EXTM3U") {
        return Err("地址返回的不是 HLS 播放列表".into());
    }
    let mut variants = Vec::new();
    let mut segments = Vec::new();
    let mut bandwidth: Option<u64> = None;
    let mut key: Option<SegmentKey> = None;
    let mut sequence = 0u64;
    let mut duration = 0.0_f64;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            duration = rest
                .split(',')
                .next()
                .and_then(|value| value.trim().parse().ok())
                .unwrap_or(0.0);
        } else if let Some(rest) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            bandwidth = Some(
                value(rest, "BANDWIDTH")
                    .and_then(|found| found.parse().ok())
                    .unwrap_or(0),
            );
        } else if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            key = parse_key(rest, base)?;
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            sequence = rest
                .trim()
                .parse()
                .map_err(|_| "播放列表的序号格式不对".to_string())?;
        } else if line.starts_with("#EXT-X-MAP") {
            return Err("这是 fMP4 格式的视频，暂不支持下载".into());
        } else if line.starts_with("#EXT-X-BYTERANGE") {
            return Err("分片使用了字节范围，暂不支持下载".into());
        } else if line.starts_with('#') {
            continue;
        } else {
            let uri = resolve(base, line)?;
            match bandwidth.take() {
                Some(bandwidth) => variants.push(Variant { bandwidth, uri }),
                None => {
                    let index = segments.len() as u64;
                    segments.push(Segment {
                        uri,
                        key: key.clone(),
                        sequence: sequence + index,
                        duration: std::mem::take(&mut duration),
                    });
                }
            }
        }
    }
    if !variants.is_empty() {
        return Ok(Playlist::Master(variants));
    }
    Ok(Playlist::Media(segments))
}

/// 码率最高的画质
pub fn best_variant(variants: Vec<Variant>) -> Option<Variant> {
    variants.into_iter().max_by_key(|variant| variant.bandwidth)
}

/// 没有指定 IV 时，按 HLS 规范用分片序号（大端，填满 16 字节）作为 IV
pub fn default_iv(sequence: u64) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[8..].copy_from_slice(&sequence.to_be_bytes());
    iv
}

/// AES-128-CBC 解密，去掉 PKCS#7 填充
pub fn decrypt_aes128(data: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Result<Vec<u8>, String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let decryptor = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv)
        .map_err(|_| "解密参数不对".to_string())?;
    decryptor
        .decrypt_padded_vec_mut::<Pkcs7>(data)
        .map_err(|_| "分片解密失败，密钥或分片内容不对".to_string())
}

fn parse_key(attrs: &str, base: &Url) -> Result<Option<SegmentKey>, String> {
    let method = value(attrs, "METHOD").unwrap_or_else(|| "NONE".into());
    match method.as_str() {
        "NONE" => Ok(None),
        "AES-128" => {
            let uri = value(attrs, "URI").ok_or("加密信息里缺少密钥地址")?;
            let iv = value(attrs, "IV").map(|hex| parse_iv(&hex)).transpose()?;
            Ok(Some(SegmentKey {
                uri: resolve(base, &uri)?,
                iv,
            }))
        }
        other => Err(format!("暂不支持的加密方式：{other}")),
    }
}

fn parse_iv(hex: &str) -> Result<[u8; 16], String> {
    const BAD: &str = "加密的 IV 格式不对";
    let digits = hex
        .strip_prefix("0x")
        .or_else(|| hex.strip_prefix("0X"))
        .unwrap_or(hex);
    if digits.len() != 32 || !digits.is_ascii() {
        return Err(BAD.into());
    }
    let mut iv = [0u8; 16];
    for (index, byte) in iv.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[index * 2..index * 2 + 2], 16)
            .map_err(|_| BAD.to_string())?;
    }
    Ok(iv)
}

fn resolve(base: &Url, raw: &str) -> Result<Url, String> {
    let url = base.join(raw).map_err(|_| format!("地址格式不对：{raw}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(format!("地址必须是 http 或 https：{raw}")),
    }
}

fn value(attrs: &str, name: &str) -> Option<String> {
    attributes(attrs)
        .into_iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
}

/// 解析 `NAME=value,NAME="quoted,value"` 形式的属性列表
fn attributes(input: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = input.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim().to_string();
        let after = &rest[eq + 1..];
        let (value, next) = match after.strip_prefix('"') {
            Some(quoted) => match quoted.find('"') {
                Some(end) => (quoted[..end].to_string(), &quoted[end + 1..]),
                None => (quoted.to_string(), ""),
            },
            None => {
                let end = after.find(',').unwrap_or(after.len());
                (after[..end].trim().to_string(), &after[end..])
            }
        };
        out.push((name, value));
        rest = next.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};

    fn base() -> Url {
        Url::parse("https://cdn.example.com/video/index.m3u8").unwrap()
    }

    #[test]
    fn master_playlist_resolves_variants_and_picks_the_highest_bitrate() {
        let text = "#EXTM3U\n\
            #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n\
            low/index.m3u8\n\
            #EXT-X-STREAM-INF:BANDWIDTH=2400000\n\
            https://other.example.com/high.m3u8\n";
        let Playlist::Master(variants) = parse(text, &base()).unwrap() else {
            panic!("应该是主播放列表");
        };
        assert_eq!(
            variants[0].uri.as_str(),
            "https://cdn.example.com/video/low/index.m3u8"
        );
        let best = best_variant(variants).unwrap();
        assert_eq!(best.bandwidth, 2_400_000);
        assert_eq!(best.uri.as_str(), "https://other.example.com/high.m3u8");
    }

    #[test]
    fn media_playlist_tracks_key_rotation_and_sequence_numbers() {
        let text = "#EXTM3U\n\
            #EXT-X-MEDIA-SEQUENCE:10\n\
            #EXT-X-KEY:METHOD=AES-128,URI=\"keys/a.key\",IV=0x00000000000000000000000000000001\n\
            #EXTINF:4.0,\n\
            s1.ts\n\
            #EXTINF:4.0,\n\
            s2.ts\n\
            #EXT-X-KEY:METHOD=NONE\n\
            #EXTINF:4.0,\n\
            s3.ts\n";
        let Playlist::Media(segments) = parse(text, &base()).unwrap() else {
            panic!("应该是媒体播放列表");
        };
        assert_eq!(segments.len(), 3);
        assert!((segments[0].duration - 4.0).abs() < 1e-9);
        assert_eq!(segments[0].sequence, 10);
        assert_eq!(segments[1].sequence, 11);
        assert_eq!(segments[2].sequence, 12);
        let first_key = segments[0].key.as_ref().unwrap();
        assert_eq!(
            first_key.uri.as_str(),
            "https://cdn.example.com/video/keys/a.key"
        );
        assert_eq!(first_key.iv.unwrap()[15], 1);
        assert!(segments[1].key.is_some());
        assert!(segments[2].key.is_none());
        assert_eq!(
            segments[2].uri.as_str(),
            "https://cdn.example.com/video/s3.ts"
        );
    }

    #[test]
    fn quoted_attribute_values_may_contain_commas() {
        let attrs = attributes(r#"METHOD=AES-128,URI="https://k.example.com/a,b.key",IV=0x1"#);
        assert_eq!(
            attrs[1],
            (
                "URI".to_string(),
                "https://k.example.com/a,b.key".to_string()
            )
        );
        assert_eq!(attrs[2], ("IV".to_string(), "0x1".to_string()));
    }

    #[test]
    fn unsupported_encryption_and_fmp4_are_refused_with_a_reason() {
        let sample_aes = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\nx.ts\n";
        let error = parse(sample_aes, &base()).unwrap_err();
        assert!(error.contains("SAMPLE-AES"), "{error}");
        let fmp4 = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\nx.m4s\n";
        assert!(parse(fmp4, &base()).unwrap_err().contains("fMP4"));
        let ranges = "#EXTM3U\n#EXT-X-BYTERANGE:100@0\nx.ts\n";
        assert!(parse(ranges, &base()).is_err());
    }

    #[test]
    fn text_that_is_not_a_playlist_is_rejected() {
        assert!(parse("<html>403</html>", &base()).is_err());
    }

    #[test]
    fn default_iv_is_the_sequence_number_in_big_endian() {
        let iv = default_iv(0x0102);
        assert_eq!(&iv[..14], &[0u8; 14]);
        assert_eq!(&iv[14..], &[0x01, 0x02]);
    }

    #[test]
    fn decrypts_what_aes_128_cbc_encrypted() {
        let key = [7u8; 16];
        let iv = default_iv(42);
        let plain = b"segment payload".to_vec();
        let cipher = cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &iv)
            .unwrap()
            .encrypt_padded_vec_mut::<Pkcs7>(&plain);
        assert_eq!(decrypt_aes128(&cipher, &key, &iv).unwrap(), plain);
        assert!(decrypt_aes128(&cipher[..15], &key, &iv).is_err());
    }
}
