fn main() {
    // 声明应用自己的命令，Tauri 会为每个命令生成 allow-* 权限，只有在 capabilities 里授权的窗口才能调用。
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "bootstrap",
            "app_info",
            "get_settings",
            "save_settings",
            "probe_servers",
            "open_server",
            "open_home",
            "open_updater",
            "open_external",
            "check_update",
            "update_state",
            "open_logs_dir",
            "diagnostics",
            "restart_app",
            "log_message",
            "download_list",
            "download_start",
            "download_cancel",
            "download_delete",
            "download_open",
            "download_folder",
        ]));
    tauri_build::try_build(attributes).expect("tauri-build 失败");
}
