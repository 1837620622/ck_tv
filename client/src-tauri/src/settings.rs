//! 本地设置：自动检查更新、线路偏好、跳过的版本。保存在系统的应用配置目录里（JSON 文件）。

use serde::{Deserialize, Deserializer, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "settings.json";
/// 允许的检查间隔（小时）
pub const INTERVALS: &[u32] = &[6, 12, 24, 168];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub auto_check_updates: bool,
    pub check_interval_hours: u32,
    pub skipped_version: Option<String>,
    pub custom_servers: Vec<String>,
    pub preferred_server: Option<String>,
    pub last_good_server: Option<String>,
    /// 上次成功拉取更新清单时用的公开代理主机名（如 gh-proxy.com）
    #[serde(default)]
    pub last_good_mirror: Option<String>,
    /// 上次国内竞速成功的 Cloudflare 优选 IP（仅 IPv4/IPv6 字面量）
    #[serde(default)]
    pub last_good_cf_ip: Option<String>,
    pub last_checked_at: Option<u64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_check_updates: true,
            check_interval_hours: 12,
            skipped_version: None,
            custom_servers: Vec::new(),
            preferred_server: None,
            last_good_server: None,
            last_good_mirror: None,
            last_good_cf_ip: None,
            last_checked_at: None,
        }
    }
}

/// 设置的局部更新。`Option<Option<T>>`：字段缺失=不改，`null`=清空，有值=设置。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub auto_check_updates: Option<bool>,
    pub check_interval_hours: Option<u32>,
    #[serde(default, deserialize_with = "double_option")]
    pub skipped_version: Option<Option<String>>,
    pub custom_servers: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub preferred_server: Option<Option<String>>,
}

fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

impl Settings {
    /// 把读到的设置修正到合法范围（文件可能被手动改坏）
    pub fn sanitize(mut self) -> Self {
        if !INTERVALS.contains(&self.check_interval_hours) {
            self.check_interval_hours = 12;
        }
        self.custom_servers = dedupe(
            self.custom_servers
                .into_iter()
                .filter_map(|url| crate::servers::normalize(&url).ok())
                .collect(),
        );
        self.preferred_server = self
            .preferred_server
            .and_then(|url| crate::servers::normalize(&url).ok());
        self.last_good_server = self
            .last_good_server
            .and_then(|url| crate::servers::normalize(&url).ok());
        self.last_good_mirror = self.last_good_mirror.as_ref().and_then(|host| {
            let cleaned = host
                .trim()
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .trim_end_matches('/')
                .to_string();
            if cleaned.is_empty() || cleaned.contains('/') || !cleaned.contains('.') {
                None
            } else {
                Some(cleaned)
            }
        });
        self.last_good_cf_ip = self.last_good_cf_ip.as_ref().and_then(|raw| {
            let cleaned = raw.trim().to_string();
            if cleaned.parse::<std::net::IpAddr>().is_ok() {
                Some(cleaned)
            } else {
                None
            }
        });
        self.prune_servers();
        self
    }

    /// 官方线路，或者用户添加过的线路（也就是候选列表里的线路）
    fn is_known(&self, url: &str) -> bool {
        crate::servers::DEFAULT_SERVERS.contains(&url)
            || self.custom_servers.iter().any(|item| item == url)
    }

    /// 首选和上次进入只能是已知线路。删掉自定义线路后，它们也一起清掉，免得又出现在列表里。
    fn prune_servers(&mut self) {
        if self
            .preferred_server
            .as_deref()
            .is_some_and(|url| !self.is_known(url))
        {
            self.preferred_server = None;
        }
        if self
            .last_good_server
            .as_deref()
            .is_some_and(|url| !self.is_known(url))
        {
            self.last_good_server = None;
        }
    }

    pub fn apply(&mut self, patch: SettingsPatch) -> Result<(), String> {
        if let Some(value) = patch.auto_check_updates {
            self.auto_check_updates = value;
        }
        if let Some(hours) = patch.check_interval_hours {
            if !INTERVALS.contains(&hours) {
                return Err("检查间隔只能是 6、12、24 小时或每周".into());
            }
            self.check_interval_hours = hours;
        }
        if let Some(version) = patch.skipped_version {
            self.skipped_version = version
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty());
        }
        if let Some(list) = patch.custom_servers {
            let mut normalized = Vec::new();
            for url in list {
                normalized.push(crate::servers::normalize(&url)?);
            }
            self.custom_servers = dedupe(normalized);
        }
        if let Some(preferred) = patch.preferred_server {
            self.preferred_server = match preferred {
                Some(url) => {
                    let url = crate::servers::normalize(&url)?;
                    if !self.is_known(&url) {
                        return Err("请先添加这条线路，再设为首选".into());
                    }
                    Some(url)
                }
                None => None,
            };
        }
        self.prune_servers();
        Ok(())
    }
}

fn dedupe(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        if !out.contains(&item) {
            out.push(item);
        }
    }
    out
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法找到配置目录：{e}"))?;
    Ok(dir.join(FILE_NAME))
}

/// 读取设置。文件不存在或损坏时使用默认值，不影响启动。
pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .map(Settings::sanitize)
        .unwrap_or_default()
}

/// 原子写入：先写临时文件再替换，避免写到一半断电时把设置写坏。
pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("无法保存设置：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("无法保存设置：{e}"))?;
    Ok(())
}

/// 当前设置（内存里的副本，读取很快）
pub fn current(app: &AppHandle) -> Settings {
    crate::lock(&app.state::<crate::AppState>().settings).clone()
}

/// 修改设置并立即写入磁盘，返回修改后的完整设置
pub fn modify(
    app: &AppHandle,
    change: impl FnOnce(&mut Settings) -> Result<(), String>,
) -> Result<Settings, String> {
    let state = app.state::<crate::AppState>();
    let mut guard = crate::lock(&state.settings);
    let mut next = guard.clone();
    change(&mut next)?;
    save(app, &next)?;
    *guard = next.clone();
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefer(url: &str) -> SettingsPatch {
        SettingsPatch {
            preferred_server: Some(Some(url.to_string())),
            ..Default::default()
        }
    }

    #[test]
    fn preferred_server_must_be_a_known_one() {
        let mut settings = Settings::default();
        assert!(settings
            .apply(prefer("https://unknown.example.com"))
            .is_err());
        assert!(settings.apply(prefer("https://ck-tv.pages.dev")).is_ok());
        assert_eq!(
            settings.preferred_server.as_deref(),
            Some("https://ck-tv.pages.dev")
        );
    }

    #[test]
    fn removing_a_custom_server_also_clears_preferred_and_last_good() {
        let mut settings = Settings {
            custom_servers: vec!["https://mirror.example.org".into()],
            last_good_server: Some("https://mirror.example.org".into()),
            ..Settings::default()
        };
        settings
            .apply(prefer("https://mirror.example.org"))
            .unwrap();
        settings
            .apply(SettingsPatch {
                custom_servers: Some(Vec::new()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(settings.preferred_server, None);
        assert_eq!(settings.last_good_server, None);
    }

    #[test]
    fn check_interval_must_be_an_offered_value() {
        let mut settings = Settings::default();
        let five = SettingsPatch {
            check_interval_hours: Some(5),
            ..Default::default()
        };
        assert!(settings.apply(five).is_err());
        let daily = SettingsPatch {
            check_interval_hours: Some(24),
            ..Default::default()
        };
        settings.apply(daily).unwrap();
        assert_eq!(settings.check_interval_hours, 24);
    }

    #[test]
    fn skipped_version_is_trimmed_and_can_be_cleared() {
        let mut settings = Settings::default();
        let skip = SettingsPatch {
            skipped_version: Some(Some(" 1.1.0 ".into())),
            ..Default::default()
        };
        settings.apply(skip).unwrap();
        assert_eq!(settings.skipped_version.as_deref(), Some("1.1.0"));
        let clear = SettingsPatch {
            skipped_version: Some(None),
            ..Default::default()
        };
        settings.apply(clear).unwrap();
        assert_eq!(settings.skipped_version, None);
    }

    #[test]
    fn sanitize_drops_a_preferred_server_that_is_not_known() {
        let settings = Settings {
            preferred_server: Some("https://unknown.example.com".into()),
            ..Settings::default()
        }
        .sanitize();
        assert_eq!(settings.preferred_server, None);
    }
}
