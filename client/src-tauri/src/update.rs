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

/// 更新清单地址（和 Release 一起发布，见 .github/workflows/app-release.yml）
pub const MANIFEST_URL: &str =
    "https://github.com/1837620622/ck_tv/releases/latest/download/update.json";

/// 下载地址只允许这些域名，防止清单被篡改后跳到钓鱼网站。
/// 和 scripts/make-update-manifest.mjs 里的列表保持一致。
/// ghfast.top 是公开的 GitHub 加速代理（国内用户直连 GitHub 很慢或打不开时用），
/// 只用来代理 github.com 的下载地址，不接受其它来源。
const ALLOWED_LINK_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "tv.chuankangkk.top",
    "ck-tv.pages.dev",
    "ghfast.top",
];

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(12);
const SCHEDULER_TICK: Duration = Duration::from_secs(15 * 60);
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(12);
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

/// 一个可以下载的安装包。默认线路是 GitHub；清单里配了国内线路时，也会一起给出。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub label: String,
    /// 默认线路（GitHub）
    pub url: String,
    /// 国内线路；没有配置时为空
    pub mirror_url: Option<String>,
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
    let (manifest, region) = tokio::join!(fetch_manifest(), region_lookup);
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
    #[serde(default)]
    pub mirror: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub source: Option<String>,
}

/// 国内用户直连 GitHub 拿不到清单时，走公开代理再试一次。
/// 清单本身很小（1KB 多），直连只是慢、还没到超时时不会触发这一级；
/// 真正的大文件下载走下面的国内线路，不走这里。
fn proxy_manifest_url() -> String {
    format!("https://ghfast.top/{MANIFEST_URL}")
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

async fn fetch_manifest() -> Result<Manifest, String> {
    let client = crate::http::client_builder()
        .timeout(MANIFEST_TIMEOUT)
        .user_agent(crate::servers::user_agent())
        .build()
        .map_err(|err| err.to_string())?;
    // 先走直连（可信源）；直连失败再走代理，代理也失败就报直连的错。
    match fetch_manifest_once(&client, MANIFEST_URL).await {
        Ok(manifest) => Ok(manifest),
        Err(direct_err) => match fetch_manifest_once(&client, &proxy_manifest_url()).await {
            Ok(manifest) => Ok(manifest),
            Err(_) => Err(direct_err),
        },
    }
}

/// 清单里没有配国内线路时，给 github.com 的下载地址自动配一条公开代理线路。
/// 这样国内用户不用等仓库配 CN_MIRROR_BASE 也能看到“国内线路”；其它域名的地址不动。
fn proxy_mirror_url(url: &str) -> Option<String> {
    let host = url.split("://").nth(1)?.split('/').next()?;
    if host != "github.com" {
        return None;
    }
    Some(format!("https://ghfast.top/{url}"))
}

/// 找出本机平台的安装包。主线路必须可信；国内线路不可信或没有，就忽略它。
fn pick_download(manifest: &Manifest, platform: &str) -> Result<Option<Download>, String> {
    let Some(entry) = manifest.platforms.get(platform) else {
        return Ok(None);
    };
    let url = validate_link(&entry.url)?;
    let mirror_url = entry
        .mirror
        .as_deref()
        .and_then(|raw| validate_link(raw).ok())
        .or_else(|| {
            proxy_mirror_url(&url).and_then(|raw| validate_link(&raw).ok())
        });
    let source_url = entry
        .source
        .as_deref()
        .and_then(|raw| validate_link(raw).ok());
    Ok(Some(Download {
        label: entry.label.clone(),
        url,
        mirror_url,
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
        // 清单里的国内线路不在白名单里，不直接用它；但主线路是 github.com，
        // 会自动配一条公开代理线路，不影响主线路
        assert_eq!(
            android.mirror_url.as_deref(),
            Some(
                "https://ghfast.top/https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_android.apk"
            )
        );
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
    fn an_untrusted_main_link_is_an_error() {
        let mut manifest = sample_manifest();
        manifest
            .platforms
            .get_mut("android")
            .expect("示例里有安卓")
            .url = "https://evil.example.com/a.apk".into();
        assert!(pick_download(&manifest, "android").is_err());
    }
}
