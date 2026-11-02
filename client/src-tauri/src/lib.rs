//! CKTV 原生客户端入口。桌面端（macOS / Windows / Linux）和移动端（Android / iOS）共用这一份代码。
//!
//! 结构：
//! - `window`：主窗口（本地启动页 → 远程站点）、更新中心窗口、导航拦截、站点注入。
//! - `servers`：线路列表、地址校验、并行测速。
//! - `settings`：本地设置（自动更新、线路偏好）。
//! - `update`：更新检测（读取更新清单，给出可用的下载线路）。
//! - `region`：判断所在地区，只用来决定弹窗里推荐哪条下载线路。
//! - `commands`：前端可调用的命令。
//! - `downloads`：本地下载（直链视频和 HLS），记录和文件都在应用数据目录里。
//! - `hls`：HLS 播放列表解析和 AES-128 分片解密，供下载使用。
//! - `menu` / `tray`：桌面端原生菜单和托盘。

mod commands;
mod downloads;
mod hls;
#[cfg(desktop)]
mod menu;
mod region;
mod servers;
mod settings;
#[cfg(desktop)]
mod tray;
mod update;
mod window;

use std::sync::{Mutex, MutexGuard};
use tauri::Manager;

/// 当前平台名，用在 User-Agent、诊断信息和站点注入里
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// 锁。中毒（某个线程 panic）时仍然取出数据，不让整个应用因此崩溃。
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 应用全局状态：设置的内存副本
pub struct AppState {
    pub settings: Mutex<settings::Settings>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // 单实例必须最先注册：第二次打开时把已有窗口拉到前面
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(main) = app.get_webview_window(window::MAIN) {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .on_menu_event(menu::handle);

    builder
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::app_info,
            commands::get_settings,
            commands::save_settings,
            commands::probe_servers,
            commands::open_server,
            commands::open_home,
            commands::open_updater,
            commands::open_external,
            commands::check_update,
            commands::update_state,
            commands::open_logs_dir,
            commands::diagnostics,
            commands::restart_app,
            commands::log_message,
            downloads::download_list,
            downloads::download_start,
            downloads::download_cancel,
            downloads::download_delete,
            downloads::download_open,
            downloads::download_folder,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded = settings::load(&handle);
            app.manage(AppState {
                settings: Mutex::new(loaded),
            });
            app.manage(update::UpdateManager::new());
            app.manage(downloads::DownloadManager::load(&handle)?);

            window::create_main(&handle)?;

            #[cfg(desktop)]
            {
                app.set_menu(menu::build(&handle)?)?;
                tray::install(&handle)?;
            }

            update::spawn_scheduler(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("CKTV 启动失败");
}
