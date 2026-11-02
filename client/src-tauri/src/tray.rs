//! 桌面端托盘图标：显示窗口、检查更新、退出。有新版本时提示框会显示版本号。

use crate::update::{Status, UpdateManager};
use crate::{update, window};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "cktv";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray-show", "显示 CKTV", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "tray-check", "检查更新", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let menu = Menu::with_items(app, &[&show, &check, &separator, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("托盘图标".into()))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("CKTV")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main(app),
            "tray-check" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    update::check(handle, true).await;
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn show_main(app: &AppHandle) {
    if let Some(main) = app.get_webview_window(window::MAIN) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 状态变化时更新托盘提示文字
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let state = app.state::<UpdateManager>().snapshot();
    let tooltip = match (state.status, state.latest_version.as_deref()) {
        (Status::Available, Some(version)) => format!("CKTV · 有新版本 {version}"),
        _ => "CKTV".to_string(),
    };
    let _ = tray.set_tooltip(Some(tooltip));
}
