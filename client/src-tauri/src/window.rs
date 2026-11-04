//! 窗口：主窗口（启动页 → 远程站点）、更新中心窗口、导航拦截、站点注入。

use crate::action_key::ActionKey;
use crate::update::{self, Status, UpdateManager, UpdateState};
use crate::{downloads, platform_name, servers, settings};
use tauri::webview::PageLoadEvent;
use tauri::window::Color;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const MAIN: &str = "main";
pub const UPDATER: &str = "updater";
pub const DOWNLOADS: &str = "downloads";
/// 注入到远程站点页面里的脚本（开场、断网提示、更新提示、回到前台检查）
const REMOTE_SCRIPT: &str = include_str!("../../src/inject/remote.js");
/// 注入脚本里签名密钥的占位符，生成脚本时换成本次启动的随机密钥（见 action_key 模块）
const ACTION_KEY_PLACEHOLDER: &str = "__CKTV_ACTION_KEY__";
/// 窗口底色和启动页一致。站点加载前窗口是这个颜色，不会闪出白屏。
const BACKGROUND: Color = Color(6, 10, 19, 255);

/// 本地页面的地址前缀。Windows 和 Android 上是 http://tauri.localhost，其它平台是 tauri://localhost
#[cfg(any(target_os = "android", target_os = "windows"))]
const LOCAL_BASE: &str = "http://tauri.localhost/";
#[cfg(not(any(target_os = "android", target_os = "windows")))]
const LOCAL_BASE: &str = "tauri://localhost/";

pub fn local_url(page: &str) -> Result<Url, String> {
    Url::parse(LOCAL_BASE)
        .and_then(|base| base.join(page))
        .map_err(|err| err.to_string())
}

fn init_script(app: &AppHandle) -> String {
    let info = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "platform": platform_name(),
        "mobile": cfg!(any(target_os = "android", target_os = "ios")),
    });
    // 密钥只写进注入脚本的闭包，不挂在 window 上，站点自己的脚本读不到
    let script = REMOTE_SCRIPT.replace(
        ACTION_KEY_PLACEHOLDER,
        &app.state::<ActionKey>().secret_hex(),
    );
    format!("window.__CKTV_APP__ = Object.freeze({info});\n{script}")
}

/// 创建主窗口。先打开本地启动页，启动页测速后再进入远程站点。
pub fn create_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let nav_app = app.clone();
    let load_app = app.clone();
    // center() 只在桌面窗口上有，手机上没有这个方法；无条件调用会在安卓/iOS 编译时报 E0599。
    // 先把 builder 拆开，桌面才加 center()，手机直接跳过，桌面行为不变。
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("CKTV")
        .background_color(BACKGROUND)
        .inner_size(1280.0, 800.0)
        .min_inner_size(360.0, 560.0);
    #[cfg(desktop)]
    let builder = builder.center();
    builder
        .initialization_script(init_script(app))
        .on_navigation(move |url| handle_navigation(&nav_app, url))
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                replay_update_toast(&load_app);
            }
        })
        .build()
}

/// 导航拦截：站点内页面留在应用里；站外网址交给系统浏览器；cktv:// 是应用自己的动作。
fn handle_navigation(app: &AppHandle, url: &Url) -> bool {
    match url.scheme() {
        "cktv" => {
            // 注意：这个回调跑在网页导航所在的 UI 线程上。以前在这里直接建窗口
            //（打开更新中心、下载页），新窗口的 WebView 初始化又要等 UI 线程，
            // 两边互相等，整个应用就会卡死无响应。只在这里取消导航，
            // 真正的动作挪到异步任务里做，回调立刻返回。
            let action_app = app.clone();
            let action_url = url.clone();
            tauri::async_runtime::spawn(async move {
                handle_action(&action_app, &action_url);
            });
            false
        }
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => {
            if url.host_str() == Some("tauri.localhost") {
                return true;
            }
            if servers::is_known_host(&settings::current(app), url) {
                return true;
            }
            log::info!("站外链接交给系统浏览器：{url}");
            let _ = app.opener().open_url(url.as_str(), None::<&str>);
            false
        }
        _ => false,
    }
}

fn handle_action(app: &AppHandle, url: &Url) {
    match url.host_str().unwrap_or_default() {
        "updater" | "update" | "settings" => {
            // 可以带 ?tab=servers，直接打开线路标签页（断网提示里的「切换线路」用到）。
            // 标签名在 open_updater 里还会再校验一次。
            let tab = url
                .query_pairs()
                .find(|(key, _)| key == "tab")
                .map(|(_, value)| value.into_owned());
            if let Err(err) = open_updater(app, tab.as_deref()) {
                log::warn!("打开更新中心失败：{err}");
            }
        }
        "home" => {
            let _ = open_home(app);
        }
        // 站点页面上的下载按钮：cktv://download?url=…&title=…[&nonce=…&sig=…]。
        // 带着有效的一次性签名（用户真的点了注入的按钮）就直接开始下载；否则只打开下载页并填好地址。
        "download" => start_or_prefill_download(app, url),
        // 站点页面上的「下载列表」按钮
        "downloads" => {
            if let Err(err) = open_downloads(app, None) {
                log::warn!("打开下载页失败：{err}");
            }
        }
        // 站点页面切回前台时发来的：距离上次检查够久了才真的去检查
        "resume" => update::spawn_resume_check(app.clone()),
        // 应用菜单里的「用浏览器打开」：cktv://browser?url=…
        "browser" => open_in_browser(app, url),
        // 站点播放时的「CKTV 播放器」：cktv://player?url=…&title=…&back=…
        "player" => open_player(app, url),
        other => log::info!("忽略未知动作：{other}"),
    }
}

fn query_value(action: &Url, name: &str) -> Option<String> {
    action
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// 站点页面请求下载。页面内容不可信，不能让它替用户写文件：
/// - 请求带着注入脚本的一次性签名（只有用户真的点了「下载本集」才会有），直接在后台开始下载，
///   并告诉页面结果，用户不用离开正在看的页面；
/// - 否则只打开下载页、把地址和名称填进表单，由用户点「开始下载」。
fn start_or_prefill_download(app: &AppHandle, action: &Url) {
    let raw = query_value(action, "url").unwrap_or_default();
    let signed = match (query_value(action, "nonce"), query_value(action, "sig")) {
        (Some(nonce), Some(signature)) => app
            .state::<ActionKey>()
            .verify("download", &raw, &nonce, &signature),
        _ => false,
    };
    if !signed {
        prefill_download(app, action);
        return;
    }
    let title = query_value(action, "title");
    let result = app
        .state::<downloads::DownloadManager>()
        .start(&raw, title.as_deref());
    let detail = match &result {
        Ok(view) => serde_json::json!({ "ok": true, "title": view.item.title }),
        Err(err) => {
            log::warn!("开始下载失败：{err}");
            serde_json::json!({ "ok": false, "error": err })
        }
    };
    if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.eval(format!(
            "window.dispatchEvent(new CustomEvent('cktv:download', {{ detail: {detail} }}));"
        ));
    }
}

/// 只打开下载页，并把地址和名称填进表单，不会直接开始；开始下载要用户在下载页里点「开始下载」。
fn prefill_download(app: &AppHandle, action: &Url) {
    let query = |name: &str| query_value(action, name);
    let source = match downloads::parse_source(&query("url").unwrap_or_default()) {
        Ok(url) => url.to_string(),
        Err(err) => {
            log::warn!("忽略站点发来的下载地址：{err}");
            return;
        }
    };
    let title = query("title").unwrap_or_default();
    if let Err(err) = open_downloads(app, Some((source.as_str(), title.as_str()))) {
        log::warn!("打开下载页失败：{err}");
    }
}

/// 「用浏览器打开」的目标地址。页面内容不可信，不能借这个动作打开任意网址：
/// 只接受 http(s)，并且必须是线路列表里的站点（也就是用户正在看的站点）。
fn browser_target(settings: &settings::Settings, action: &Url) -> Option<Url> {
    let raw = action
        .query_pairs()
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())?;
    let target = Url::parse(&raw).ok()?;
    if !matches!(target.scheme(), "http" | "https") {
        return None;
    }
    servers::is_known_host(settings, &target).then_some(target)
}

fn open_in_browser(app: &AppHandle, action: &Url) {
    let Some(target) = browser_target(&settings::current(app), action) else {
        log::warn!("忽略不在线路列表里的地址：{action}");
        return;
    };
    if let Err(err) = app.opener().open_url(target.as_str(), None::<&str>) {
        log::warn!("用浏览器打开失败：{err}");
    }
}

/// CKTV 播放器页面的地址。参数来自站点页面，不可信：
/// 视频地址只接受 http(s)；返回地址只接受线路列表里的站点，否则不带（播放器里按「返回」走历史记录）。
fn player_page(settings: &settings::Settings, action: &Url) -> Option<String> {
    let source = Url::parse(&query_value(action, "url")?).ok()?;
    if !matches!(source.scheme(), "http" | "https") {
        return None;
    }
    let title: String = query_value(action, "title")
        .unwrap_or_default()
        .chars()
        .take(120)
        .collect();
    let back = query_value(action, "back")
        .and_then(|raw| Url::parse(&raw).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .filter(|url| servers::is_known_host(settings, url));
    let mut page = Url::parse("http://localhost/player.html").expect("固定的地址");
    {
        let mut query = page.query_pairs_mut();
        query.append_pair("src", source.as_str());
        if !title.is_empty() {
            query.append_pair("title", &title);
        }
        if let Some(back) = &back {
            query.append_pair("back", back.as_str());
        }
    }
    Some(format!("player.html?{}", page.query().unwrap_or_default()))
}

/// 在主窗口里打开 CKTV 播放器（手机和电脑都是主窗口，返回时回到站点页面）
fn open_player(app: &AppHandle, action: &Url) {
    let Some(page) = player_page(&settings::current(app), action) else {
        log::warn!("忽略无效的播放请求：{action}");
        return;
    };
    let result = local_url(&page).and_then(|url| {
        app.get_webview_window(MAIN)
            .ok_or_else(|| "主窗口不存在".to_string())?
            .navigate(url)
            .map_err(|err| err.to_string())
    });
    if let Err(err) = result {
        log::warn!("打开播放器失败：{err}");
    }
}

/// 把待提示的更新推给当前页面（远程站点会显示右下角的提示卡片）
pub fn push_update_toast(app: &AppHandle, state: &UpdateState) {
    let Some(main) = app.get_webview_window(MAIN) else {
        return;
    };
    let detail = serde_json::json!({
        "version": state.latest_version,
        "notes": state.notes.as_deref().unwrap_or_default().chars().take(160).collect::<String>(),
        "platform": state.platform,
    });
    let script =
        format!("window.dispatchEvent(new CustomEvent('cktv:update', {{ detail: {detail} }}));");
    let _ = main.eval(&script);
}

/// 页面加载完成后，如果还有没处理的更新，重新推一次（页面刷新或换线路后提示仍然在）
fn replay_update_toast(app: &AppHandle) {
    let state = app.state::<UpdateManager>().snapshot();
    if state.status == Status::Available && !state.skipped {
        push_update_toast(app, &state);
    }
}

/// 打开更新中心。桌面端是独立窗口；手机端在主窗口里打开页面，页面里有返回按钮。
/// `tab` 可选：update | servers | about，决定打开后停在哪个标签页。
pub fn open_updater(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
    open_updater_impl(app, tab)
}

/// 打开下载页。桌面端是独立窗口；手机端在主窗口里打开，页面里有返回按钮。
/// `prefill` 有值时（站点请求下载），页面把地址和名称填进表单，但不会开始下载。
pub fn open_downloads(app: &AppHandle, prefill: Option<(&str, &str)>) -> Result<(), String> {
    open_downloads_impl(app, prefill)
}

/// 下载页的地址。要预填时，地址和名称放在查询参数里，和更新中心的 ?tab= 一样。
fn downloads_page(prefill: Option<(&str, &str)>) -> String {
    let Some((source, title)) = prefill else {
        return "downloads.html".to_string();
    };
    let mut url = Url::parse("http://localhost/downloads.html").expect("固定的地址");
    url.query_pairs_mut()
        .append_pair("url", source)
        .append_pair("title", title);
    format!("downloads.html?{}", url.query().unwrap_or_default())
}

#[cfg(desktop)]
fn open_downloads_impl(app: &AppHandle, prefill: Option<(&str, &str)>) -> Result<(), String> {
    let page = downloads_page(prefill);
    if let Some(window) = app.get_webview_window(DOWNLOADS) {
        if let Some((source, title)) = prefill {
            // 窗口已经开着：直接把地址填进去（和更新中心切换标签页的做法一样）
            let detail = serde_json::json!({ "url": source, "title": title });
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('cktv:prefill', {{ detail: {detail} }}));"
            ));
        }
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, DOWNLOADS, WebviewUrl::App(page.into()))
        .title("CKTV 下载")
        .background_color(BACKGROUND)
        .inner_size(880.0, 640.0)
        .min_inner_size(360.0, 480.0)
        .center()
        .build()
        .map_err(|err| err.to_string())?;
    #[cfg(any(windows, target_os = "linux"))]
    let _ = window.remove_menu();
    Ok(())
}

#[cfg(mobile)]
fn open_downloads_impl(app: &AppHandle, prefill: Option<(&str, &str)>) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    main.navigate(local_url(&downloads_page(prefill))?)
        .map_err(|err| err.to_string())
}

/// 只接受三个标签页的名字。这个值会放进页面地址和脚本里，所以其它内容一律忽略。
fn valid_tab(tab: Option<&str>) -> Option<&str> {
    tab.filter(|item| matches!(*item, "update" | "servers" | "about"))
}

/// 更新中心页面的地址，带上要打开的标签页
fn updater_page(tab: Option<&str>) -> String {
    match valid_tab(tab) {
        Some(tab) => format!("updates.html?tab={tab}"),
        None => "updates.html".to_string(),
    }
}

#[cfg(desktop)]
fn open_updater_impl(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
    let page = updater_page(tab);
    if let Some(window) = app.get_webview_window(UPDATER) {
        // 窗口已经开着：让它切到对应标签页
        if let Some(tab) = valid_tab(tab) {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('cktv:tab', {{ detail: '{tab}' }}));"
            ));
        }
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let window = WebviewWindowBuilder::new(app, UPDATER, WebviewUrl::App(page.into()))
        .title("CKTV 更新中心")
        .background_color(BACKGROUND)
        .inner_size(800.0, 600.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .decorations(false)
        .resizable(true)
        .build()
        .map_err(|err| err.to_string())?;
    // 窗口自己画了标题栏，就不要再显示系统菜单栏（Windows 和 Linux 上菜单会出现在窗口顶部）。
    // macOS 的菜单是整个应用共用的，这个调用不适用。
    #[cfg(any(windows, target_os = "linux"))]
    let _ = window.remove_menu();
    Ok(())
}

#[cfg(mobile)]
fn open_updater_impl(app: &AppHandle, tab: Option<&str>) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    main.navigate(local_url(&updater_page(tab))?)
        .map_err(|err| err.to_string())
}

/// 回到启动页（启动页会重新测速并进入最快的线路）
pub fn open_home(app: &AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "主窗口不存在".to_string())?;
    main.navigate(local_url("index.html")?)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_page_carries_the_prefill_without_breaking_it() {
        assert_eq!(downloads_page(None), "downloads.html");
        let source = "https://cdn.example.com/a.m3u8?x=1&y=2#frag";
        let page = downloads_page(Some((source, "第 1 集 & 特别篇")));
        let (path, query) = page.split_once('?').expect("有查询参数");
        assert_eq!(path, "downloads.html");
        let pairs: Vec<(String, String)> = Url::parse(&format!("http://localhost/?{query}"))
            .expect("能解析")
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("url".to_string(), source.to_string()),
                ("title".to_string(), "第 1 集 & 特别篇".to_string()),
            ]
        );
    }

    #[test]
    fn updater_page_only_accepts_known_tabs() {
        assert_eq!(updater_page(Some("servers")), "updates.html?tab=servers");
        assert_eq!(updater_page(Some("about")), "updates.html?tab=about");
        assert_eq!(updater_page(Some("x');alert(1);//")), "updates.html");
        assert_eq!(updater_page(None), "updates.html");
    }

    fn browser_action(target: &str) -> Url {
        let mut action = Url::parse("cktv://browser").expect("固定的地址");
        action.query_pairs_mut().append_pair("url", target);
        action
    }

    fn player_action(pairs: &[(&str, &str)]) -> Url {
        let mut action = Url::parse("cktv://player").expect("固定的地址");
        for (key, value) in pairs {
            action.query_pairs_mut().append_pair(key, value);
        }
        action
    }

    fn player_params(page: &str) -> Vec<(String, String)> {
        let query = page.strip_prefix("player.html?").expect("播放器页面");
        Url::parse(&format!("http://localhost/?{query}"))
            .unwrap()
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect()
    }

    #[test]
    fn player_page_keeps_valid_parameters_only() {
        let settings = settings::Settings::default();
        let page = player_page(
            &settings,
            &player_action(&[
                ("url", "https://cdn.example.com/a/index.m3u8?t=1&x=2"),
                ("title", "第 1 集 & 特别篇"),
                ("back", "https://tv.chuankangkk.top/play?id=9"),
            ]),
        )
        .unwrap();
        assert_eq!(
            player_params(&page),
            vec![
                (
                    "src".to_string(),
                    "https://cdn.example.com/a/index.m3u8?t=1&x=2".to_string()
                ),
                ("title".to_string(), "第 1 集 & 特别篇".to_string()),
                (
                    "back".to_string(),
                    "https://tv.chuankangkk.top/play?id=9".to_string()
                ),
            ]
        );
        // 返回地址不是线路站点（或是 javascript:）时丢掉
        for back in ["https://evil.example.com/", "javascript:alert(1)"] {
            let page = player_page(
                &settings,
                &player_action(&[("url", "https://cdn.example.com/v.mp4"), ("back", back)]),
            )
            .unwrap();
            assert!(
                player_params(&page).iter().all(|(key, _)| key != "back"),
                "{back}"
            );
        }
        // 视频地址必须是 http(s)
        for source in ["javascript:alert(1)", "file:///etc/passwd", ""] {
            assert_eq!(
                player_page(&settings, &player_action(&[("url", source)])),
                None
            );
        }
    }

    #[test]
    fn browser_action_only_opens_the_current_site() {
        let settings = settings::Settings::default();
        let page = "https://tv.chuankangkk.top/play?id=1&ep=2";
        assert_eq!(
            browser_target(&settings, &browser_action(page)).map(|url| url.to_string()),
            Some(page.to_string())
        );
        // 不在线路列表里的站点、非 http(s) 地址、缺少参数，一律不打开
        for target in [
            "https://evil.example.com/",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert_eq!(
                browser_target(&settings, &browser_action(target)),
                None,
                "{target}"
            );
        }
        let empty = Url::parse("cktv://browser").expect("固定的地址");
        assert_eq!(browser_target(&settings, &empty), None);
    }
}
