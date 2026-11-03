//! 所在地区判断。只用来决定弹窗里推荐哪条下载线路，不做其它用途，也不保存。
//! 请求 Cloudflare 的 cdn-cgi/trace：它返回一段文字，其中 loc= 是国家或地区代码。
//! 超时或失败时返回 Unknown，界面会同时给出两条线路，让用户自己选。

use serde::Serialize;
use std::time::Duration;

const TRACE_URL: &str = "https://www.cloudflare.com/cdn-cgi/trace";
const TRACE_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Region {
    /// 中国大陆
    Cn,
    /// 其它地区（包括香港、台湾、澳门）
    Other,
    /// 无法判断
    Unknown,
}

/// 国家或地区代码 → 地区。XX 是无法判断，T1 是 Tor 出口。
pub fn from_loc(loc: &str) -> Region {
    match loc.trim().to_ascii_uppercase().as_str() {
        "" | "XX" | "T1" => Region::Unknown,
        "CN" => Region::Cn,
        _ => Region::Other,
    }
}

/// 解析 cdn-cgi/trace 的内容：每行一个 key=value，只看 loc=
pub fn parse_trace(body: &str) -> Region {
    body.lines()
        .find_map(|line| line.strip_prefix("loc="))
        .map(from_loc)
        .unwrap_or(Region::Unknown)
}

pub async fn detect() -> Region {
    let client = match crate::http::client_builder()
        .timeout(TRACE_TIMEOUT)
        .user_agent(crate::servers::user_agent())
        .build()
    {
        Ok(client) => client,
        Err(_) => return Region::Unknown,
    };
    let region = match client.get(TRACE_URL).send().await {
        Ok(response) if response.status().is_success() => match response.text().await {
            Ok(body) => parse_trace(&body),
            Err(_) => Region::Unknown,
        },
        _ => Region::Unknown,
    };
    log::info!("所在地区判断结果：{region:?}");
    region
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_country_code_from_the_trace_page() {
        let body = "fl=1f1\nh=www.cloudflare.com\nip=203.0.113.7\nloc=CN\ntls=TLSv1.3\n";
        assert_eq!(parse_trace(body), Region::Cn);
        assert_eq!(parse_trace("loc=US\n"), Region::Other);
        assert_eq!(parse_trace("loc=XX\n"), Region::Unknown);
        assert_eq!(parse_trace("ip=1.2.3.4\n"), Region::Unknown);
        assert_eq!(parse_trace(""), Region::Unknown);
    }

    #[test]
    fn hong_kong_taiwan_and_macau_are_not_mainland_china() {
        assert_eq!(from_loc("HK"), Region::Other);
        assert_eq!(from_loc("tw"), Region::Other);
        assert_eq!(from_loc("MO"), Region::Other);
        assert_eq!(from_loc("cn"), Region::Cn);
        assert_eq!(from_loc("T1"), Region::Unknown);
    }
}
