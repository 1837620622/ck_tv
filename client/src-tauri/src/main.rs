// 发布版在 Windows 上不弹出黑色控制台窗口
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    cktv_app_lib::run();
}
