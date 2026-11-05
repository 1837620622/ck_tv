//! 前端可以调用的命令。只有本地页面（启动页、离线页、更新中心）能调用，远程站点拿不到这些权限。

use crate::settings::{self, Settings, SettingsPatch};
use crate::update::{self, UpdateManager, UpdateState};
use crate::{platform_name, region, servers, window};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
    pub platform: String,
    pub arch: String,
    pub mobile: bool,
    pub debug: bool,
    pub user_agent: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub app: AppInfo,
    pub settings: Settings,
    pub candidates: Vec<String>,
    pub update: UpdateState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app: AppInfo,
    pub settings: Settings,
    pub update: UpdateState,
    pub log_dir: Option<String>,
    pub candidates: Vec<String>,
}

fn info(app: &AppHandle) -> AppInfo {
    let config = app.config();
    AppInfo {
        name: config.product_name.clone().unwrap_or_else(|| "CKTV".into()),
        version: app.package_info().version.to_string(),
        identifier: config.identifier.clone(),
        platform: platform_name().to_string(),
        arch: std::env::consts::ARCH.to_string(),
        mobile: cfg!(any(target_os = "android", target_os = "ios")),
        debug: cfg!(debug_assertions),
        user_agent: servers::user_agent(),
    }
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    info(&app)
}

/// 启动页需要的全部信息，一次返回，减少往返
#[tauri::command]
pub fn bootstrap(app: AppHandle) -> BootInfo {
    let settings = settings::current(&app);
    BootInfo {
        app: info(&app),
        candidates: servers::candidates(&settings),
        settings,
        update: app.state::<UpdateManager>().snapshot(),
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    settings::current(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, patch: SettingsPatch) -> Result<Settings, String> {
    settings::modify(&app, |current| current.apply(patch))
}

/// 并行测速。不传参数时测当前所有候选线路。
#[tauri::command]
pub async fn probe_servers(
    app: AppHandle,
    urls: Option<Vec<String>>,
) -> Result<Vec<servers::Probe>, String> {
    let settings = settings::current(&app);
    let list = match urls {
        Some(list) => {
            let mut normalized = Vec::new();
            for url in list {
                normalized.push(servers::normalize(&url)?);
            }
            normalized
        }
        None => servers::candidates(&settings),
    };
    let region = region::detect().await;
    let results =
        servers::probe_all_with_prefer(list, region, settings.last_good_cf_ip.as_deref()).await;
    // 官方线路测通时记住本次优选 IP，下次优先用
    if let Some(ip) = crate::cf_prefer::current_ip().await {
        let hit = results.iter().any(|probe| {
            probe.ok
                && servers::DEFAULT_SERVERS
                    .iter()
                    .any(|server| probe.url.starts_with(server))
        });
        if hit {
            let _ = settings::modify(&app, |s| {
                s.last_good_cf_ip = Some(ip.to_string());
                Ok(())
            });
        }
    }
    Ok(results)
}

/// 进入某条线路。只能进入候选列表里的线路。
#[tauri::command]
pub fn open_server(app: AppHandle, url: String) -> Result<(), String> {
    let target = servers::normalize(&url)?;
    let known = servers::candidates(&settings::current(&app)).contains(&target);
    if !known {
        return Err("这条线路不在列表里".into());
    }
    let main = app
        .get_webview_window(window::MAIN)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let parsed = tauri::Url::parse(&target).map_err(|err| err.to_string())?;
    main.navigate(parsed).map_err(|err| err.to_string())?;
    let _ = settings::modify(&app, |s| {
        s.last_good_server = Some(target.clone());
        Ok(())
    });
    Ok(())
}

#[tauri::command]
pub fn open_home(app: AppHandle) -> Result<(), String> {
    window::open_home(&app)
}

#[tauri::command]
pub fn open_updater(app: AppHandle, tab: Option<String>) -> Result<(), String> {
    window::open_updater(&app, tab.as_deref())
}

/// 用系统浏览器打开外部链接（只允许白名单域名）
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    let safe = update::validate_link(&url)?;
    app.opener()
        .open_url(safe, None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn check_update(app: AppHandle, manual: bool) -> Result<UpdateState, String> {
    Ok(update::check(app, manual).await)
}

#[tauri::command]
pub fn update_state(app: AppHandle) -> UpdateState {
    app.state::<UpdateManager>().snapshot()
}

#[tauri::command]
pub fn open_logs_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|err| err.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}

/// 诊断信息：界面上「复制诊断信息」用，方便反馈问题
#[tauri::command]
pub fn diagnostics(app: AppHandle) -> Diagnostics {
    let settings = settings::current(&app);
    Diagnostics {
        app: info(&app),
        candidates: servers::candidates(&settings),
        settings,
        update: app.state::<UpdateManager>().snapshot(),
        log_dir: app
            .path()
            .app_log_dir()
            .ok()
            .map(|dir| dir.to_string_lossy().to_string()),
    }
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart()
}

/// 前端日志统一写进应用日志
#[tauri::command]
pub fn log_message(level: String, message: String) {
    let message = message.chars().take(2000).collect::<String>();
    match level.as_str() {
        "error" => log::error!("[ui] {message}"),
        "warn" => log::warn!("[ui] {message}"),
        _ => log::info!("[ui] {message}"),
    }
}
