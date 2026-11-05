//! 更新检查。所有平台都读取同一份清单 update.json（和 Release 一起发布），找到本机对应的安装包，
//! 再让用户在浏览器里下载。应用不替换自己，所以不需要任何更新签名密钥。
//! - 桌面端（macOS / Windows / Linux）：下载后手动安装。
//! - 安卓：下载 APK 后覆盖安装。
//! - iOS：通过 AltStore 添加源后安装（用户用自己的 Apple ID 重签）。

use crate::region::{self, Region};
use crate::settings::{self, Settings};
use crate::{platform_name, window};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::task::JoinSet;

/// 更新清单地址（和 Release 一起发布，见 .github/workflows/app-release.yml）
pub const MANIFEST_URL: &str =
    "https://github.com/1837620622/ck_tv/releases/latest/download/update.json";

/// 公开 GitHub 加速代理前缀（2026-11-05 探测：能返回合法 update.json 的才收录）。
/// 与 scripts/make-update-manifest.mjs 的 ALLOWED_HOSTS 保持一致。
pub const PROXY_PREFIXES: &[&str] = &[
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://edgeone.gh-proxy.com/",
];

/// 下载地址只允许这些域名，防止清单被篡改后跳到钓鱼网站。
/// 和 scripts/make-update-manifest.mjs 里的列表保持一致。
const ALLOWED_LINK_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "tv.chuankangkk.top",
    "ck-tv.pages.dev",
    "ghfast.top",
    "gh-proxy.com",
    "edgeone.gh-proxy.com",
];

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(12);
const SCHEDULER_TICK: Duration = Duration::from_secs(15 * 60);
/// 清单竞速：单路超时（直连与各代理并行，谁先成功用谁）
const MANIFEST_RACE_TIMEOUT: Duration = Duration::from_secs(3);
/// 切回前台时，距离上次检查不到这么久就不再检查
const RESUME_GAP_MS: u64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Idle,
    Checking,
    UpToDate,
    Available,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: Status,
    pub platform: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    /// 本机平台的安装包；清单里没有给这个平台时为空
    pub download: Option<Download>,
    /// GitHub 发布页，能看到这次发布的全部文件
    pub release_url: Option<String>,
    /// 所在地区，只用来决定弹窗里推荐哪条下载线路
    pub region: Region,
    /// 用户选择了跳过这个版本
    pub skipped: bool,
    pub error: Option<String>,
    pub checked_at: Option<u64>,
}

impl UpdateState {
    fn initial() -> Self {
        Self {
            status: Status::Idle,
            platform: platform_name().to_string(),
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            notes: None,
            published_at: None,
            download: None,
            release_url: None,
            region: Region::Unknown,
            skipped: false,
            error: None,
            checked_at: None,
        }
    }
}

/// 一个可以下载的安装包。默认线路是 GitHub；清单里配了国内线路或公开代理时，也会一起给出。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub label: String,
    /// 默认线路（GitHub）
    pub url: String,
    /// 首选国内线路（官方 CN_MIRROR 或第一条代理），兼容旧界面
    pub mirror_url: Option<String>,
    /// 全部国内/代理线路，按推荐顺序（含 mirror_url）
    #[serde(default)]
    pub mirrors: Vec<String>,
    pub sha256: Option<String>,
    pub size: Option<u64>,
    /// iOS：AltStore 源地址，在 AltStore 里添加后即可安装和更新
    pub source_url: Option<String>,
}

/// 更新状态，以及所在地区的缓存（地区只查询一次；查询失败时下次检查再试）
pub struct UpdateManager {
    state: std::sync::Mutex<UpdateState>,
    region: std::sync::Mutex<Option<Region>>,
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(UpdateState::initial()),
            region: std::sync::Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> UpdateState {
        crate::lock(&self.state).clone()
    }
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 修改状态并广播给所有界面
fn update_state(app: &AppHandle, change: impl FnOnce(&mut UpdateState)) -> UpdateState {
    let manager = app.state::<UpdateManager>();
    let snapshot = {
        let mut guard = crate::lock(&manager.state);
        change(&mut guard);
        guard.clone()
    };
    let _ = app.emit("update-state", &snapshot);
    #[cfg(desktop)]
    crate::tray::refresh(app);
    snapshot
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 新版本是否比当前版本高（都按 semver 比较，无法解析时不提示）
pub fn is_newer(latest: &str, current: &str) -> bool {
    let latest = semver::Version::parse(latest.trim().trim_start_matches('v'));
    let current = semver::Version::parse(current.trim().trim_start_matches('v'));
    matches!((latest, current), (Ok(l), Ok(c)) if l > c)
}

/// 只允许 https 且在白名单里的下载地址
pub fn validate_link(raw: &str) -> Result<String, String> {
    let url = tauri::Url::parse(raw).map_err(|_| "下载地址格式不对".to_string())?;
    if url.scheme() != "https" {
        return Err("下载地址必须是 https 开头".into());
    }
    let host = url.host_str().unwrap_or_default();
    let allowed = ALLOWED_LINK_HOSTS
        .iter()
        .any(|item| host == *item || host.ends_with(&format!(".{item}")));
    if allowed {
        Ok(url.to_string())
    } else {
        Err(format!("不信任的下载地址：{host}"))
    }
}

fn skipped_for(settings: &Settings, version: Option<&str>) -> bool {
    match (settings.skipped_version.as_deref(), version) {
        (Some(skipped), Some(latest)) => skipped == latest,
        _ => false,
    }
}

fn record_checked(app: &AppHandle, checked_at: u64) {
    let _ = settings::modify(app, |s| {
        s.last_checked_at = Some(checked_at);
        Ok(())
    });
}

fn record_good_mirror(app: &AppHandle, host: &str) {
    let host = host.trim();
    if host.is_empty() {
        return;
    }
    let _ = settings::modify(app, |s| {
        s.last_good_mirror = Some(host.to_string());
        Ok(())
    });
}

/// 手动或自动检查。结果会广播给界面，并刷新托盘提示。
pub async fn check(app: AppHandle, manual: bool) -> UpdateState {
    log::info!("检查更新（手动：{manual}）");
    update_state(&app, |s| {
        s.status = Status::Checking;
        s.error = None;
    });
    let state = run_check(&app).await;
    // 只有检查成功才记下时间。失败时（没网、线路暂时打不开）不记，定时器会在下一次检查时间再试，
    // 而不是等满一个检查间隔才重试。
    if state.status != Status::Error {
        record_checked(&app, now_ms());
    }
    state
}

/// 读取清单和所在地区（两者同时进行），再选出本机平台的安装包
async fn run_check(app: &AppHandle) -> UpdateState {
    let settings = settings::current(app);
    let manager = app.state::<UpdateManager>();
    let cached = *crate::lock(&manager.region);
    let region_lookup = async {
        match cached {
            Some(region) => region,
            None => region::detect().await,
        }
    };
    let (manifest, region) = tokio::join!(
        fetch_manifest(app, settings.last_good_mirror.as_deref()),
        region_lookup
    );
    if region != Region::Unknown {
        *crate::lock(&manager.region) = Some(region);
    }

    let manifest = match manifest {
        Ok(manifest) => manifest,
        Err(err) => {
            return update_state(app, |s| {
                s.status = Status::Error;
                s.error = Some(err);
                s.region = region;
                s.checked_at = Some(now_ms());
            });
        }
    };

    let newer = is_newer(&manifest.version, env!("CARGO_PKG_VERSION"));
    let download = if newer {
        match pick_download(&manifest, platform_name()) {
            Ok(download) => download,
            Err(err) => {
                return update_state(app, |s| {
                    s.status = Status::Error;
                    s.error = Some(err);
                    s.region = region;
                    s.checked_at = Some(now_ms());
                });
            }
        }
    } else {
        None
    };
    let skipped = newer && skipped_for(&settings, Some(manifest.version.as_str()));

    update_state(app, |s| {
        s.status = if newer {
            Status::Available
        } else {
            Status::UpToDate
        };
        s.latest_version = Some(manifest.version.clone());
        s.notes = manifest.notes.clone();
        s.published_at = manifest.pub_date.clone();
        s.download = download;
        s.release_url = manifest
            .release_url
            .as_deref()
            .and_then(|raw| validate_link(raw).ok());
        s.region = region;
        s.skipped = skipped;
        s.error = None;
        s.checked_at = Some(now_ms());
    })
}

/// update.json：和 Release 一起发布，由 scripts/make-update-manifest.mjs 生成
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub release_url: Option<String>,
    /// 键是平台名：macos、windows、linux、android、ios
    #[serde(default)]
    pub platforms: BTreeMap<String, PlatformEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformEntry {
    pub label: String,
    pub url: String,
    /// 旧字段：单条国内线路（兼容）
    #[serde(default)]
    pub mirror: Option<String>,
    /// 新字段：多条国内线路
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub source: Option<String>,
}

/// 从代理清单 URL 里取出公开代理主机名；直连 GitHub 返回 None
fn proxy_host_of(url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_string();
    if host == "github.com" || host.ends_with(".githubusercontent.com") {
        return None;
    }
    if ALLOWED_LINK_HOSTS
        .iter()
        .any(|item| host == *item || host.ends_with(&format!(".{item}")))
    {
        Some(host)
    } else {
        None
    }
}

/// 清单候选：上次成功的代理优先，再直连，再其它代理
fn manifest_candidates(last_good: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |url: String| {
        if !out.iter().any(|item| item == &url) {
            out.push(url);
        }
    };
    if let Some(host) = last_good {
        let host = host.trim();
        if let Some(prefix) = PROXY_PREFIXES
            .iter()
            .find(|p| p.contains(host) || (*p).contains(&format!("//{host}/")))
        {
            push(format!("{prefix}{MANIFEST_URL}"));
        } else if !host.is_empty() && !host.contains('/') {
            push(format!("https://{host}/{MANIFEST_URL}"));
        }
    }
    push(MANIFEST_URL.to_string());
    for prefix in PROXY_PREFIXES {
        push(format!("{prefix}{MANIFEST_URL}"));
    }
    out
}

async fn fetch_manifest_once(client: &reqwest::Client, url: &str) -> Result<Manifest, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法获取更新信息，请检查网络".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "更新服务暂时不可用（{}）",
            response.status().as_u16()
        ));
    }
    response
        .json::<Manifest>()
        .await
        .map_err(|_| "更新信息格式不对".to_string())
}

/// 并行竞速拉取清单：2–3 秒超时，谁先成功用谁；成功的公开代理写入 last_good_mirror
async fn fetch_manifest(app: &AppHandle, last_good: Option<&str>) -> Result<Manifest, String> {
    let client = crate::http::client_builder()
        .timeout(MANIFEST_RACE_TIMEOUT)
        .user_agent(crate::servers::user_agent())
        .build()
        .map_err(|err| err.to_string())?;
    let candidates = manifest_candidates(last_good);
    let mut set = JoinSet::new();
    for url in candidates {
        let client = client.clone();
        set.spawn(async move {
            let result = fetch_manifest_once(&client, &url).await;
            (url, result)
        });
    }

    let mut first_err: Option<String> = None;
    while let Some(joined) = set.join_next().await {
        let Ok((url, result)) = joined else {
            continue;
        };
        match result {
            Ok(manifest) => {
                if let Some(host) = proxy_host_of(&url) {
                    record_good_mirror(app, &host);
                    log::info!("更新清单命中代理：{host}");
                } else {
                    log::info!("更新清单命中直连 GitHub");
                }
                set.abort_all();
                return Ok(manifest);
            }
            Err(err) => {
                if first_err.is_none() {
                    first_err = Some(err);
                }
            }
        }
    }
    Err(first_err.unwrap_or_else(|| "无法获取更新信息，请检查网络".into()))
}

/// 收集清单里的 mirror / mirrors，并在主线路是 github.com 时自动补公开代理
fn collect_mirrors(entry: &PlatformEntry, url: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        if let Ok(v) = validate_link(raw) {
            if !out.iter().any(|item| item == &v) {
                out.push(v);
            }
        }
    };
    for m in &entry.mirrors {
        push(m);
    }
    if let Some(m) = entry.mirror.as_deref() {
        push(m);
    }
    let host = url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("");
    if host == "github.com" {
        for prefix in PROXY_PREFIXES {
            push(&format!("{prefix}{url}"));
        }
    }
    out
}

/// 找出本机平台的安装包。主线路必须可信；国内线路不可信或没有，就忽略它。
fn pick_download(manifest: &Manifest, platform: &str) -> Result<Option<Download>, String> {
    let Some(entry) = manifest.platforms.get(platform) else {
        return Ok(None);
    };
    let url = validate_link(&entry.url)?;
    let mirrors = collect_mirrors(entry, &url);
    let mirror_url = mirrors.first().cloned();
    let source_url = entry
        .source
        .as_deref()
        .and_then(|raw| validate_link(raw).ok());
    Ok(Some(Download {
        label: entry.label.clone(),
        url,
        mirror_url,
        mirrors,
        sha256: entry.sha256.clone(),
        size: entry.size,
        source_url,
    }))
}

/// 后台定时检查。设置里关闭了自动检查，或者还没到间隔时间，就什么都不做。
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let current = settings::current(&app);
            if current.auto_check_updates && is_due(&current) {
                let state = check(app.clone(), false).await;
                if state.status == Status::Available && !state.skipped {
                    window::push_update_toast(&app, &state);
                }
            }
            tokio::time::sleep(SCHEDULER_TICK).await;
        }
    });
}

/// 站点页面切回前台时调用（remote.js 发来 cktv://resume）。
/// 只有自动检查开着、距离上次检查已经超过半小时、并且当前没有在检查时，才真的去检查。
pub fn spawn_resume_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let checking = app.state::<UpdateManager>().snapshot().status == Status::Checking;
        let current = settings::current(&app);
        if checking || !current.auto_check_updates {
            return;
        }
        if !is_resume_due(current.last_checked_at, now_ms()) {
            return;
        }
        let state = check(app.clone(), false).await;
        if state.status == Status::Available && !state.skipped {
            window::push_update_toast(&app, &state);
        }
    });
}

/// 从没检查过，或者距离上次检查已经超过 RESUME_GAP_MS，才在切回前台时检查
fn is_resume_due(last_checked_at: Option<u64>, now: u64) -> bool {
    match last_checked_at {
        None => true,
        Some(last) => now.saturating_sub(last) >= RESUME_GAP_MS,
    }
}

fn is_due(settings: &Settings) -> bool {
    match settings.last_checked_at {
        None => true,
        Some(last) => {
            let interval_ms = u64::from(settings.check_interval_hours) * 3_600_000;
            now_ms().saturating_sub(last) >= interval_ms
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_must_be_https_and_on_the_allowlist() {
        assert!(validate_link("https://github.com/1837620622/ck_tv/releases").is_ok());
        assert!(validate_link("https://objects.githubusercontent.com/asset").is_ok());
        assert!(validate_link("https://gh-proxy.com/https://github.com/x").is_ok());
        assert!(validate_link("https://edgeone.gh-proxy.com/https://github.com/x").is_ok());
        assert!(validate_link("http://github.com/asset").is_err());
        assert!(validate_link("https://evil.example.com/app.apk").is_err());
        assert!(validate_link("https://github.com.evil.example/app.apk").is_err());
        assert!(validate_link("not a url").is_err());
    }

    #[test]
    fn only_a_higher_semver_counts_as_newer() {
        assert!(is_newer("1.1.0", "1.0.0"));
        assert!(is_newer("v1.0.1", "1.0.0"));
        assert!(!is_newer("1.0.0", "1.0.0"));
        assert!(!is_newer("0.9.9", "1.0.0"));
        assert!(!is_newer("not-a-version", "1.0.0"));
    }

    #[test]
    fn a_skipped_version_only_hides_that_version() {
        let settings = Settings {
            skipped_version: Some("1.1.0".into()),
            ..Settings::default()
        };
        assert!(skipped_for(&settings, Some("1.1.0")));
        assert!(!skipped_for(&settings, Some("1.2.0")));
        assert!(!skipped_for(&settings, None));
    }

    #[test]
    fn a_check_is_due_when_never_run_or_after_the_interval() {
        assert!(is_due(&Settings::default()));
        let just_now = Settings {
            last_checked_at: Some(now_ms()),
            ..Settings::default()
        };
        assert!(!is_due(&just_now));
        let long_ago = Settings {
            last_checked_at: Some(now_ms() - 13 * 3_600_000),
            ..Settings::default()
        };
        assert!(is_due(&long_ago));
    }

    #[test]
    fn resume_check_waits_half_an_hour() {
        let now = 10 * RESUME_GAP_MS;
        assert!(is_resume_due(None, now));
        assert!(!is_resume_due(Some(now - 1), now));
        assert!(!is_resume_due(Some(now - RESUME_GAP_MS + 1), now));
        assert!(is_resume_due(Some(now - RESUME_GAP_MS), now));
    }

    fn sample_manifest() -> Manifest {
        serde_json::from_str(
            r#"{
                "version": "1.1.0",
                "pubDate": "2026-11-02",
                "notes": "修复若干问题",
                "releaseUrl": "https://github.com/1837620622/ck_tv/releases/tag/app-v1.1.0",
                "platforms": {
                    "android": {
                        "label": "安卓 APK",
                        "url": "https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_android.apk",
                        "mirror": "https://evil.example.com/CKTV_1.1.0_android.apk",
                        "sha256": "abc",
                        "size": 10
                    },
                    "ios": {
                        "label": "iPhone / iPad",
                        "url": "https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_ios-unsigned.ipa",
                        "source": "https://github.com/1837620622/ck_tv/releases/latest/download/altstore.json"
                    }
                }
            }"#,
        )
        .expect("示例清单应该能解析")
    }

    #[test]
    fn picks_the_download_for_this_platform_only() {
        let manifest = sample_manifest();
        let android = pick_download(&manifest, "android")
            .expect("安卓的地址可信")
            .expect("有安装包");
        assert_eq!(android.sha256.as_deref(), Some("abc"));
        assert_eq!(android.size, Some(10));
        // 清单里的国内线路不在白名单里，忽略；主线路是 github.com，自动配公开代理
        assert!(android
            .mirror_url
            .as_deref()
            .is_some_and(|u| u.contains("gh")));
        assert!(android.mirrors.len() >= 2);
        assert!(android
            .mirrors
            .iter()
            .all(|u| u.starts_with("https://") && u.contains("github.com")));
        let ios = pick_download(&manifest, "ios")
            .expect("iOS 的地址可信")
            .expect("有安装包");
        assert_eq!(
            ios.source_url.as_deref(),
            Some("https://github.com/1837620622/ck_tv/releases/latest/download/altstore.json")
        );
        assert!(pick_download(&manifest, "windows").unwrap().is_none());
    }

    #[test]
    fn mirrors_array_in_manifest_is_preferred() {
        let mut manifest = sample_manifest();
        let android = manifest.platforms.get_mut("android").expect("示例里有安卓");
        android.mirror = None;
        android.mirrors = vec![
            "https://tv.chuankangkk.top/cktv/app-v1.1.0/CKTV_1.1.0_android.apk".into(),
            "https://evil.example.com/bad.apk".into(),
        ];
        let download = pick_download(&manifest, "android")
            .unwrap()
            .expect("有安装包");
        assert_eq!(
            download.mirror_url.as_deref(),
            Some("https://tv.chuankangkk.top/cktv/app-v1.1.0/CKTV_1.1.0_android.apk")
        );
        assert!(!download
            .mirrors
            .iter()
            .any(|u| u.contains("evil.example.com")));
    }

    #[test]
    fn an_untrusted_main_link_is_an_error() {
        let mut manifest = sample_manifest();
        manifest
            .platforms
            .get_mut("android")
            .expect("示例里有安卓")
            .url = "https://evil.example.com/a.apk".into();
        assert!(pick_download(&manifest, "android").is_err());
    }

    #[test]
    fn last_good_mirror_is_tried_first() {
        let urls = manifest_candidates(Some("gh-proxy.com"));
        assert!(urls[0].starts_with("https://gh-proxy.com/"));
        assert!(urls.iter().any(|u| u == MANIFEST_URL));
    }
}
