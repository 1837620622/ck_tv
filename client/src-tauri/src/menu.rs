//! 桌面端原生菜单（macOS 顶部菜单栏 / Windows、Linux 窗口菜单栏）

use crate::{update, window};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

/// 当前缩放比例（百分比），每次启动从 100% 开始
static ZOOM_PERCENT: AtomicU32 = AtomicU32::new(100);
const ISSUES_URL: &str = "https://github.com/1837620622/ck_tv/issues";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = PredefinedMenuItem::about(
        app,
        Some("关于 CKTV"),
        Some(AboutMetadata {
            name: Some("CKTV".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            copyright: Some("CKTV 传康播放器".into()),
            ..Default::default()
        }),
    )?;
    let check = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let updater = MenuItem::with_id(
        app,
        "open-updater",
        "更新中心与设置…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let reload = MenuItem::with_id(app, "reload", "重新加载", true, Some("CmdOrCtrl+R"))?;
    let back = MenuItem::with_id(app, "back", "后退", true, Some("CmdOrCtrl+["))?;
    let home = MenuItem::with_id(app, "home", "回到启动页", true, Some("CmdOrCtrl+Shift+H"))?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "放大", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "缩小", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", "实际大小", true, Some("CmdOrCtrl+0"))?;
    let logs = MenuItem::with_id(app, "open-logs", "打开日志文件夹", true, None::<&str>)?;
    let report = MenuItem::with_id(app, "report", "反馈问题…", true, None::<&str>)?;
    let close_window = PredefinedMenuItem::close_window(app, None)?;
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let maximize = PredefinedMenuItem::maximize(app, None)?;
    #[cfg(target_os = "macos")]
    let sep_app_1 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "macos")]
    let sep_app_2 = PredefinedMenuItem::separator(app)?;
    #[cfg(target_os = "macos")]
    let sep_app_3 = PredefinedMenuItem::separator(app)?;
    let sep_file = PredefinedMenuItem::separator(app)?;
    let sep_edit = PredefinedMenuItem::separator(app)?;
    let sep_view = PredefinedMenuItem::separator(app)?;
    let sep_help = PredefinedMenuItem::separator(app)?;

    #[cfg(target_os = "macos")]
    let app_menu = {
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let quit = PredefinedMenuItem::quit(app, None)?;
        Submenu::with_items(
            app,
            "CKTV",
            true,
            &[
                &about,
                &sep_app_1,
                &check,
                &updater,
                &sep_app_2,
                &hide,
                &hide_others,
                &show_all,
                &sep_app_3,
                &quit,
            ],
        )?
    };

    #[cfg(not(target_os = "macos"))]
    let quit = PredefinedMenuItem::quit(app, None)?;

    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        #[cfg(target_os = "macos")]
        &[&home, &reload, &back, &sep_file, &close_window],
        #[cfg(not(target_os = "macos"))]
        &[&home, &reload, &back, &sep_file, &close_window, &quit],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[&undo, &redo, &sep_edit, &cut, &copy, &paste, &select_all],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[&zoom_in, &zoom_out, &zoom_reset, &sep_view, &fullscreen],
    )?;

    let window_menu = Submenu::with_items(app, "窗口", true, &[&minimize, &maximize])?;

    // macOS 的「关于」在应用菜单里；Windows / Linux 放到帮助菜单里
    let help_menu = Submenu::with_items(
        app,
        "帮助",
        true,
        #[cfg(target_os = "macos")]
        &[&check, &updater, &sep_help, &logs, &report],
        #[cfg(not(target_os = "macos"))]
        &[&about, &check, &updater, &sep_help, &logs, &report],
    )?;

    #[cfg(target_os = "macos")]
    let items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = vec![
        &app_menu,
        &file_menu,
        &edit_menu,
        &view_menu,
        &window_menu,
        &help_menu,
    ];
    #[cfg(not(target_os = "macos"))]
    let items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        vec![&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu];

    Menu::with_items(app, &items)
}

pub fn handle(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "check-update" => {
            let _ = window::open_updater(app, Some("update"));
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                update::check(handle, true).await;
            });
        }
        "open-updater" => {
            let _ = window::open_updater(app, None);
        }
        "reload" => eval_main(app, "location.reload()"),
        "back" => eval_main(app, "history.back()"),
        "home" => {
            let _ = window::open_home(app);
        }
        "zoom-in" => set_zoom(app, ZOOM_PERCENT.load(Ordering::Relaxed) + 10),
        "zoom-out" => set_zoom(app, ZOOM_PERCENT.load(Ordering::Relaxed).saturating_sub(10)),
        "zoom-reset" => set_zoom(app, 100),
        "open-logs" => {
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
        }
        "report" => {
            let _ = app.opener().open_url(ISSUES_URL, None::<&str>);
        }
        _ => {}
    }
}

fn eval_main(app: &AppHandle, script: &str) {
    if let Some(main) = app.get_webview_window(window::MAIN) {
        let _ = main.eval(script);
    }
}

fn set_zoom(app: &AppHandle, percent: u32) {
    let clamped = percent.clamp(50, 200);
    ZOOM_PERCENT.store(clamped, Ordering::Relaxed);
    if let Some(main) = app.get_webview_window(window::MAIN) {
        let _ = main.set_zoom(f64::from(clamped) / 100.0);
    }
}
