//! 线路（站点地址）：候选列表、地址校验、并行测速。

use crate::settings::Settings;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::Url;
use tokio::task::JoinSet;

/// 官方线路：主域名优先，Pages 域名作为备用
pub const DEFAULT_SERVERS: &[&str] = &["https://tv.chuankangkk.top", "https://ck-tv.pages.dev"];

/// 把用户输入整理成 origin（如 https://tv.chuankangkk.top）。只允许 https。
/// 调试版额外允许 http://127.0.0.1 和 localhost，方便本地联调。
pub fn normalize(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("请输入线路地址".into());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| "线路地址格式不对".to_string())?;
    let local_dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"));
    if url.scheme() != "https" && !local_dev {
        return Err("线路地址必须以 https:// 开头".into());
    }
    if url.host_str().is_none() {
        return Err("线路地址缺少域名".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("线路地址不能包含账号和密码".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// 候选线路的顺序：用户首选 > 上次成功 > 官方 > 自定义。去重。
pub fn candidates(settings: &Settings) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |url: &str| {
        if !out.iter().any(|item| item == url) {
            out.push(url.to_string());
        }
    };
    if let Some(preferred) = &settings.preferred_server {
        push(preferred);
    }
    if let Some(last) = &settings.last_good_server {
        push(last);
    }
    for url in DEFAULT_SERVERS {
        push(url);
    }
    for url in &settings.custom_servers {
        push(url);
    }
    out
}

/// 地址是不是我们认识的线路（用来决定导航留在应用里，还是交给系统浏览器）
pub fn is_known_host(settings: &Settings, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    candidates(settings).iter().any(|candidate| {
        Url::parse(candidate)
            .ok()
            .and_then(|parsed| parsed.host_str().map(|h| h == host))
            .unwrap_or(false)
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub url: String,
    pub ok: bool,
    pub status: Option<u16>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

pub fn user_agent() -> String {
    format!(
        "CKTV-App/{} ({})",
        env!("CARGO_PKG_VERSION"),
        crate::platform_name()
    )
}

/// 并行测速，结果顺序和输入一致。站点只要有响应（非 5xx）就算线路可用。
/// 国内 / 未知地区时先竞速 Cloudflare 优选 IP，再测线路（TLS SNI 仍是原域名）。
pub async fn probe_all_with_prefer(
    urls: Vec<String>,
    region: crate::region::Region,
    saved_cf_ip: Option<&str>,
) -> Vec<Probe> {
    let prefer_ip = crate::cf_prefer::prepare(region, saved_cf_ip).await;
    let client = match crate::cf_prefer::apply_resolves(
        crate::http::client_builder()
            .connect_timeout(Duration::from_secs(4))
            .timeout(Duration::from_secs(8))
            .user_agent(user_agent()),
        prefer_ip,
    )
    .build()
    {
        Ok(client) => client,
        Err(err) => {
            return urls
                .into_iter()
                .map(|url| failed(url, err.to_string()))
                .collect()
        }
    };

    let mut set = JoinSet::new();
    for (index, url) in urls.iter().cloned().enumerate() {
        let client = client.clone();
        set.spawn(async move { (index, probe_one(&client, url).await) });
    }

    let mut results: Vec<Option<Probe>> = vec![None; urls.len()];
    while let Some(joined) = set.join_next().await {
        if let Ok((index, probe)) = joined {
            results[index] = Some(probe);
        }
    }
    results
        .into_iter()
        .zip(urls)
        .map(|(probe, url)| probe.unwrap_or_else(|| failed(url, "测速失败".into())))
        .collect()
}

fn failed(url: String, error: String) -> Probe {
    Probe {
        url,
        ok: false,
        status: None,
        latency_ms: None,
        error: Some(error),
    }
}

fn probe_from_response(url: String, started: Instant, response: reqwest::Response) -> Probe {
    let code = response.status().as_u16();
    let ok = code < 500;
    Probe {
        url,
        ok,
        status: Some(code),
        latency_ms: Some(started.elapsed().as_millis() as u64),
        error: if ok {
            None
        } else {
            Some(format!("服务器错误 {code}"))
        },
    }
}

fn probe_err_reason(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "连接超时"
    } else if err.is_connect() {
        "无法连接"
    } else {
        "请求失败"
    }
}

async fn probe_one(client: &reqwest::Client, url: String) -> Probe {
    let started = Instant::now();
    match client.head(&url).send().await {
        Ok(response) => probe_from_response(url, started, response),
        Err(head_err) => {
            // 部分线路拒绝 HEAD 或中间设备丢弃 HEAD：改用 GET 再试一次
            match client.get(&url).send().await {
                Ok(response) => probe_from_response(url, started, response),
                Err(_) => failed(url, probe_err_reason(&head_err).into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_keeps_only_the_origin() {
        assert_eq!(
            normalize("tv.chuankangkk.top").unwrap(),
            "https://tv.chuankangkk.top"
        );
        assert_eq!(
            normalize("  https://ck-tv.pages.dev/some/path?x=1 ").unwrap(),
            "https://ck-tv.pages.dev"
        );
        assert_eq!(
            normalize("https://example.com:8443/").unwrap(),
            "https://example.com:8443"
        );
    }

    #[test]
    fn normalize_rejects_empty_plain_http_and_credentials() {
        assert!(normalize("").is_err());
        assert!(normalize("   ").is_err());
        assert!(normalize("http://example.com").is_err());
        assert!(normalize("https://user:pass@example.com").is_err());
    }

    #[test]
    fn candidates_put_preferred_first_and_skip_duplicates() {
        let settings = Settings {
            preferred_server: Some("https://ck-tv.pages.dev".into()),
            last_good_server: Some("https://tv.chuankangkk.top".into()),
            custom_servers: vec![
                "https://mirror.example.org".into(),
                "https://tv.chuankangkk.top".into(),
            ],
            ..Settings::default()
        };
        assert_eq!(
            candidates(&settings),
            vec![
                "https://ck-tv.pages.dev",
                "https://tv.chuankangkk.top",
                "https://mirror.example.org"
            ]
        );
    }

    #[test]
    fn only_candidate_hosts_stay_inside_the_app() {
        let settings = Settings::default();
        assert!(is_known_host(
            &settings,
            &Url::parse("https://tv.chuankangkk.top/play/1").unwrap()
        ));
        assert!(!is_known_host(
            &settings,
            &Url::parse("https://evil.example.com").unwrap()
        ));
    }
}
