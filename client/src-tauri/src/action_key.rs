//! 站点页面请求「直接开始下载」时的一次性签名。
//!
//! 站点页面是远程内容，不能让它随便让应用往本机写文件。所以：
//! - 应用启动时生成一个随机密钥，只放进注入脚本（src/inject/remote.js）的闭包里，页面自己的脚本读不到。
//! - 用户真的点了注入的「下载本集」按钮（`event.isTrusted`）时，注入脚本用这个密钥对
//!   「动作 | 视频地址 | 随机数」做 HMAC-SHA256 签名，随请求一起发来。
//! - 这里验证签名，并且每个随机数只认一次：即使页面截获了一次请求，也不能拿去重放。
//!
//! 没有签名或签名不对的请求，仍然只打开下载页、填好地址，由用户确认后再开始。

use std::collections::HashSet;
use std::fmt::Write as _;
use std::sync::Mutex;

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::lock;

/// 随机数是 16 字节，写成 32 个十六进制字符
const NONCE_HEX_LEN: usize = 32;
/// 记住的已用随机数上限：超过后清空（密钥本身不变，旧请求的随机数不会再出现）
const MAX_REMEMBERED: usize = 10_000;

pub struct ActionKey {
    secret: [u8; 32],
    used: Mutex<HashSet<String>>,
}

impl ActionKey {
    pub fn new() -> Result<Self, String> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|err| format!("生成随机密钥失败：{err}"))?;
        Ok(Self::with_secret(secret))
    }

    fn with_secret(secret: [u8; 32]) -> Self {
        Self {
            secret,
            used: Mutex::new(HashSet::new()),
        }
    }

    /// 写进注入脚本的密钥（十六进制）
    pub fn secret_hex(&self) -> String {
        hex(&self.secret)
    }

    /// 验证签名，并把随机数记为已用。签名对、随机数没用过才返回 true。
    pub fn verify(&self, action: &str, value: &str, nonce: &str, signature: &str) -> bool {
        if nonce.len() != NONCE_HEX_LEN || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let Some(signature) = unhex(signature) else {
            return false;
        };
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC 接受任意长度的密钥");
        mac.update(message(action, value, nonce).as_bytes());
        // verify_slice 是常数时间比较
        if mac.verify_slice(&signature).is_err() {
            return false;
        }
        let mut used = lock(&self.used);
        if used.len() >= MAX_REMEMBERED {
            used.clear();
        }
        used.insert(nonce.to_ascii_lowercase())
    }
}

/// 签名的内容，注入脚本那边按同样的格式拼
fn message(action: &str, value: &str, nonce: &str) -> String {
    format!("{action}|{value}|{}", nonce.to_ascii_lowercase())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(key: &ActionKey, action: &str, value: &str, nonce: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(&key.secret).unwrap();
        mac.update(message(action, value, nonce).as_bytes());
        hex(&mac.finalize().into_bytes())
    }

    const NONCE: &str = "00112233445566778899aabbccddeeff";
    const URL: &str = "https://cdn.example.com/a/index.m3u8";

    #[test]
    fn a_valid_signature_is_accepted_once() {
        let key = ActionKey::with_secret([7; 32]);
        let signature = sign(&key, "download", URL, NONCE);
        assert!(key.verify("download", URL, NONCE, &signature));
        // 同一个随机数第二次就不认了（防重放）
        assert!(!key.verify("download", URL, NONCE, &signature));
    }

    #[test]
    fn tampered_requests_are_rejected() {
        let key = ActionKey::with_secret([7; 32]);
        let signature = sign(&key, "download", URL, NONCE);
        // 换了地址、换了动作、签名被改、随机数格式不对、别的密钥签的，一律不认
        assert!(!key.verify(
            "download",
            "https://evil.example.com/x.mp4",
            NONCE,
            &signature
        ));
        assert!(!key.verify("delete", URL, NONCE, &signature));
        let mut broken = signature.clone();
        broken.replace_range(0..2, if &signature[0..2] == "00" { "01" } else { "00" });
        assert!(!key.verify("download", URL, NONCE, &broken));
        assert!(!key.verify("download", URL, "short", &signature));
        assert!(!key.verify("download", URL, NONCE, "not-hex"));
        let other = ActionKey::with_secret([8; 32]);
        assert!(!other.verify("download", URL, NONCE, &signature));
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
        assert_eq!(unhex("000fff"), Some(vec![0, 15, 255]));
        assert_eq!(unhex("0g"), None);
        assert_eq!(ActionKey::with_secret([0xab; 32]).secret_hex().len(), 64);
    }
}
