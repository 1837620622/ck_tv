//! 国内访问 Cloudflare Pages 时，系统 DNS 常解析到难连通的 Anycast IP。
//! 这里维护一份「优选 IP」：对 tv.chuankangkk.top / ck-tv.pages.dev 用 reqwest::resolve
//! 强制连到测过能出 200 的 IP（TLS SNI 仍是原域名），竞速后记住最快的。
//!
//! 列表来源：内置默认 → 远程 `cf-prefer-ips.json`（站点 / GitHub raw / 代理）。

use crate::region::Region;
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tokio::task::JoinSet;

/// 需要走优选 IP 的主机名（与官方线路一致）
pub const TARGET_HOSTS: &[&str] = &["tv.chuankangkk.top", "ck-tv.pages.dev"];

/// 内置默认列表（2026-11-05 用 SNI=tv.chuankangkk.top 验证过 HTTP 200）
pub const BUNDLED_IPS: &[&str] = &[
    "104.18.46.217",
    "104.17.152.238",
    "104.16.241.229",
    "104.16.147.159",
    "190.93.247.169",
    "104.17.127.110",
    "162.159.158.51",
    "104.21.91.19",
    "172.67.147.37",
    "104.18.42.155",
    "172.64.148.207",
    "104.21.65.160",
    "188.114.96.125",
    "198.41.212.130",
    "188.114.97.1",
    "104.20.30.123",
    "104.16.114.175",
    "104.20.255.53",
    "104.25.105.1",
    "104.18.35.2",
    "104.19.231.123",
    "104.16.100.50",
    "172.64.145.88",
    "104.27.21.118",
];

/// 远程列表地址（并行拉取，谁先返回合法 JSON 用谁）
pub const REMOTE_LIST_URLS: &[&str] = &[
    "https://tv.chuankangkk.top/cf-prefer-ips.json",
    "https://ck-tv.pages.dev/cf-prefer-ips.json",
    "https://ghfast.top/raw.githubusercontent.com/1837620622/ck_tv/main/public/cf-prefer-ips.json",
    "https://raw.githubusercontent.com/1837620622/ck_tv/main/public/cf-prefer-ips.json",
];

const RACE_TIMEOUT: Duration = Duration::from_secs(3);
const REMOTE_TIMEOUT: Duration = Duration::from_secs(4);
/// 一次竞速最多同时测这么多 IP（含 last_good）
const RACE_LIMIT: usize = 8;

#[derive(Debug, Deserialize)]
struct RemoteList {
    ips: Vec<String>,
}

struct Cache {
    ips: Vec<IpAddr>,
    picked: Option<IpAddr>,
}

fn cache() -> &'static RwLock<Cache> {
    static CACHE: OnceLock<RwLock<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        RwLock::new(Cache {
            ips: parse_ips(BUNDLED_IPS.iter().copied()),
            picked: None,
        })
    })
}

fn parse_ips<'a>(items: impl IntoIterator<Item = &'a str>) -> Vec<IpAddr> {
    let mut out = Vec::new();
    for raw in items {
        if let Ok(ip) = IpAddr::from_str(raw.trim()) {
            if !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    out
}

/// 把优选 IP 绑到目标主机名上。非目标主机不受影响。
pub fn apply_resolves(
    mut builder: reqwest::ClientBuilder,
    ip: Option<IpAddr>,
) -> reqwest::ClientBuilder {
    let Some(ip) = ip else {
        return builder;
    };
    let addr = SocketAddr::new(ip, 443);
    for host in TARGET_HOSTS {
        builder = builder.resolve(host, addr);
    }
    builder
}

/// 当前已选中的优选 IP（可能还没竞速过）
pub async fn current_ip() -> Option<IpAddr> {
    cache().read().await.picked
}

/// 解析 settings 里保存的 last_good_cf_ip
pub fn parse_saved_ip(raw: Option<&str>) -> Option<IpAddr> {
    raw.and_then(|s| IpAddr::from_str(s.trim()).ok())
}

/// 国内地区：刷新远程列表（失败保留内置），竞速选出最快 IP。
/// 其它地区：清掉绑定，走系统 DNS。
pub async fn prepare(region: Region, saved: Option<&str>) -> Option<IpAddr> {
    if region != Region::Cn && region != Region::Unknown {
        let mut guard = cache().write().await;
        guard.picked = None;
        return None;
    }

    refresh_remote_list().await;

    let saved_ip = parse_saved_ip(saved);
    let list = {
        let guard = cache().read().await;
        guard.ips.clone()
    };

    let mut candidates: Vec<IpAddr> = Vec::new();
    if let Some(ip) = saved_ip {
        candidates.push(ip);
    }
    if let Some(ip) = current_ip().await {
        if !candidates.contains(&ip) {
            candidates.push(ip);
        }
    }
    for ip in list {
        if !candidates.contains(&ip) {
            candidates.push(ip);
        }
        if candidates.len() >= RACE_LIMIT {
            break;
        }
    }

    let winner = race(candidates).await;
    let mut guard = cache().write().await;
    guard.picked = winner;
    if let Some(ip) = winner {
        log::info!("CF 优选 IP：{ip}");
    } else {
        log::info!("CF 优选 IP：竞速未选出，回退系统 DNS");
    }
    winner
}

async fn refresh_remote_list() {
    let client = match crate::http::client_builder()
        .timeout(REMOTE_TIMEOUT)
        .user_agent(crate::servers::user_agent())
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    let mut set = JoinSet::new();
    for url in REMOTE_LIST_URLS {
        let client = client.clone();
        let url = (*url).to_string();
        set.spawn(async move {
            let response = client.get(&url).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            let body = response.text().await.ok()?;
            let parsed: RemoteList = serde_json::from_str(&body).ok()?;
            let ips = parse_ips(parsed.ips.iter().map(String::as_str));
            if ips.is_empty() {
                None
            } else {
                Some(ips)
            }
        });
    }

    while let Some(joined) = set.join_next().await {
        if let Ok(Some(ips)) = joined {
            let mut guard = cache().write().await;
            // 远程在前，内置补齐
            let mut merged = ips;
            for ip in parse_ips(BUNDLED_IPS.iter().copied()) {
                if !merged.contains(&ip) {
                    merged.push(ip);
                }
            }
            guard.ips = merged;
            log::info!("已更新 CF 优选 IP 列表（{} 条）", guard.ips.len());
            return;
        }
    }
}

async fn race(candidates: Vec<IpAddr>) -> Option<IpAddr> {
    if candidates.is_empty() {
        return None;
    }
    let mut set = JoinSet::new();
    for ip in candidates {
        set.spawn(async move {
            let started = Instant::now();
            let ok = probe_ip(ip).await;
            (ip, ok, started.elapsed())
        });
    }

    let mut best: Option<(IpAddr, Duration)> = None;
    while let Some(joined) = set.join_next().await {
        let Ok((ip, ok, elapsed)) = joined else {
            continue;
        };
        if !ok {
            continue;
        }
        match best {
            None => best = Some((ip, elapsed)),
            Some((_, best_elapsed)) if elapsed < best_elapsed => best = Some((ip, elapsed)),
            _ => {}
        }
    }
    best.map(|(ip, _)| ip)
}

async fn probe_ip(ip: IpAddr) -> bool {
    let builder = apply_resolves(
        crate::http::client_builder()
            .connect_timeout(RACE_TIMEOUT)
            .timeout(RACE_TIMEOUT)
            .user_agent(crate::servers::user_agent()),
        Some(ip),
    );
    let Ok(client) = builder.build() else {
        return false;
    };
    // 用轻量 trace，确认 TLS + 该主机名证书都通
    match client
        .get("https://tv.chuankangkk.top/cdn-cgi/trace")
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_ips_parse_and_are_unique() {
        let ips = parse_ips(BUNDLED_IPS.iter().copied());
        assert_eq!(ips.len(), BUNDLED_IPS.len());
        assert!(ips.len() >= 8);
    }

    #[test]
    fn target_hosts_cover_official_servers() {
        assert!(TARGET_HOSTS.contains(&"tv.chuankangkk.top"));
        assert!(TARGET_HOSTS.contains(&"ck-tv.pages.dev"));
        assert!(!TARGET_HOSTS.contains(&"github.com"));
    }

    #[test]
    fn apply_resolves_accepts_ipv4() {
        let ip = IpAddr::from_str("104.18.46.217").unwrap();
        assert!(apply_resolves(crate::http::client_builder(), Some(ip))
            .build()
            .is_ok());
    }

    #[test]
    fn remote_list_json_shape() {
        let sample = r#"{"updated":"2026-11-05","hosts":["tv.chuankangkk.top"],"ips":["104.18.46.217","172.67.147.37"]}"#;
        let parsed: RemoteList = serde_json::from_str(sample).unwrap();
        assert_eq!(parsed.ips.len(), 2);
    }
}
