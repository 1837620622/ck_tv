//! 本地下载：把视频保存到应用数据目录下的 downloads 文件夹，记录在 downloads.json 里，重启后仍然可见。
//!
//! 两种来源：
//! - 直链视频（mp4、webm 等）：边下载边写入文件，内存里只保留一个数据块。
//! - HLS（.m3u8）：选最高码率，分片最多 4 个并发下载；AES-128 分片在本机解密后，
//!   按顺序写成 00000.ts、00001.ts……，然后合成一个 `<id>.mp4`（见 remux 模块），删掉分片，
//!   得到一个任何播放器都能直接打开的视频文件。fMP4 分片直接拼接成 MP4。
//!   TS 里是 H.265 等暂不支持的编码时，保留分片和本地 index.m3u8，应用内照样能播放。
//!   SAMPLE-AES 等 DRM 加密直接报错，不生成残缺的文件。
//!
//! 进度只在内存里更新，并通过事件通知界面；写进 downloads.json 的只有开始、完成、失败、取消几次，避免频繁写盘。

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{stream, StreamExt};
use reqwest::header::CONTENT_TYPE;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

use crate::hls::{self, Playlist, Segment};
use crate::{lock, remux, servers};

/// 下载状态变化时发给界面的事件，载荷是 [`View`]
pub const EVENT: &str = "download-changed";
const DIR_NAME: &str = "downloads";
const INDEX_FILE: &str = "downloads.json";
const MAX_URL_LEN: usize = 8192;
const MAX_TITLE_CHARS: usize = 120;
/// 播放列表、密钥、分片各有大小上限，防止异常地址把内存撑爆
const MAX_PLAYLIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_KEY_BYTES: usize = 64;
const MAX_SEGMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_SEGMENTS: usize = 20_000;
/// HLS 同时下载的分片数：足够快，又不会给服务器太大压力
const SEGMENT_PARALLELISM: usize = 4;
/// 直链视频每写入这么多字节，通知界面一次
const PROGRESS_STEP: u64 = 1024 * 1024;
const CANCELLED: &str = "已取消";
/// 分片下载完、正在合成 MP4 时的阶段名，界面据此显示「正在合成 MP4」
pub const STAGE_CONVERTING: &str = "converting";
const VIDEO_EXTENSIONS: [&str; 7] = ["mp4", "webm", "m4v", "mov", "mkv", "flv", "ts"];

/// 下载的种类
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// 直链视频，或已经合成好的 MP4：一个文件，进度单位是字节
    File,
    /// HLS：下载时是一个装着分片的文件夹，进度单位是分片。合成 MP4 成功后改成 File；
    /// 编码不支持合成时保留文件夹和 index.m3u8
    Hls,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Done,
    Failed,
    Canceled,
}

/// 一条下载记录，保存在 downloads.json 里
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub title: String,
    pub source: String,
    pub kind: Kind,
    /// 入口文件，相对于下载目录：直链和合成好的视频是 `<id>.mp4`，保留分片时是 `<id>/index.m3u8`
    pub entry: String,
    pub status: Status,
    /// 已完成的进度：直链是字节数，HLS 是分片数
    pub done: u64,
    /// 总量：直链可能未知（0），HLS 是分片总数
    pub total: u64,
    pub error: Option<String>,
    pub created_ms: u64,
    /// 下载中的阶段：None 是正在下载，`converting` 是分片已下载完、正在合成 MP4
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
}

/// 发给界面的一项：多了入口文件的绝对路径，界面用它播放
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    #[serde(flatten)]
    pub item: Item,
    pub path: String,
}

#[derive(Default, Serialize, Deserialize)]
struct IndexFile {
    items: Vec<Item>,
}

#[derive(Default)]
struct Records {
    /// 最新的排在前面
    items: Vec<Item>,
    /// 还在下载的项目的取消开关
    cancels: HashMap<String, Arc<AtomicBool>>,
}

/// 下载管理器：整个应用只有一个，由 `app.manage` 托管
pub struct DownloadManager {
    app: AppHandle,
    dir: PathBuf,
    index: PathBuf,
    records: Mutex<Records>,
    sequence: AtomicU64,
}

impl DownloadManager {
    /// 启动时读取记录。上次退出时还在下载的，任务已经不存在了，标记为失败。
    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let base = app.path().app_data_dir().map_err(|err| err.to_string())?;
        let dir = base.join(DIR_NAME);
        std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建下载目录：{err}"))?;
        let index = base.join(INDEX_FILE);
        let mut items = std::fs::read(&index)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<IndexFile>(&bytes).ok())
            .map(|file| file.items)
            .unwrap_or_default();
        for item in items
            .iter_mut()
            .filter(|item| item.status == Status::Running)
        {
            item.status = Status::Failed;
            item.error = Some("应用退出前没有下载完成，可以删除后重新下载".into());
        }
        let manager = Self {
            app: app.clone(),
            dir,
            index,
            records: Mutex::new(Records {
                items,
                cancels: HashMap::new(),
            }),
            sequence: AtomicU64::new(0),
        };
        manager.persist(&lock(&manager.records));
        Ok(manager)
    }

    /// 下载目录，入口文件都在这里面
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn list(&self) -> Vec<View> {
        lock(&self.records)
            .items
            .iter()
            .map(|item| self.view(item))
            .collect()
    }

    /// 开始一个新的下载：立刻返回这一项，真正的下载在后台进行
    pub fn start(&self, source: &str, title: Option<&str>) -> Result<View, String> {
        let url = parse_source(source)?;
        let id = self.next_id();
        let kind = if is_playlist_url(&url) {
            Kind::Hls
        } else {
            Kind::File
        };
        let item = Item {
            title: clean_title(title).unwrap_or_else(|| default_title(&url)),
            source: url.to_string(),
            kind,
            entry: entry_for(kind, &id, &url),
            id: id.clone(),
            status: Status::Running,
            done: 0,
            total: 0,
            error: None,
            created_ms: now_ms(),
            stage: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let view = {
            let mut records = lock(&self.records);
            records.items.insert(0, item.clone());
            records.cancels.insert(id.clone(), cancel.clone());
            self.persist(&records);
            self.view(&item)
        };
        self.emit(&view);
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move { run(app, id, cancel).await });
        Ok(view)
    }

    /// 请求取消一个正在进行的下载，任务会在下一个分片或数据块处停下
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        match lock(&self.records).cancels.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            None => Err("这一项已经不在下载中".into()),
        }
    }

    /// 删除记录和文件。正在下载的要先取消。
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let item = {
            let mut records = lock(&self.records);
            if records.cancels.contains_key(id) {
                return Err("正在下载，请先取消".into());
            }
            let position = records
                .items
                .iter()
                .position(|item| item.id == id)
                .ok_or("找不到这一项")?;
            let item = records.items.remove(position);
            self.persist(&records);
            item
        };
        self.delete_files(&item);
        Ok(())
    }

    /// 下载完成的项目，返回入口文件的绝对路径
    pub fn entry_path(&self, id: &str) -> Result<PathBuf, String> {
        let item = self.snapshot(id).ok_or("找不到这一项")?;
        if item.status != Status::Done {
            return Err("还没有下载完成".into());
        }
        Ok(self.dir.join(&item.entry))
    }

    fn snapshot(&self, id: &str) -> Option<Item> {
        lock(&self.records)
            .items
            .iter()
            .find(|item| item.id == id)
            .cloned()
    }

    fn view(&self, item: &Item) -> View {
        View {
            path: self.dir.join(&item.entry).to_string_lossy().into_owned(),
            item: item.clone(),
        }
    }

    fn emit(&self, view: &View) {
        if let Err(err) = self.app.emit(EVENT, view) {
            log::debug!("通知界面下载状态失败：{err}");
        }
    }

    /// 把记录写进 downloads.json：先写临时文件，再替换，避免写到一半时断电把记录弄坏
    fn persist(&self, records: &Records) {
        let file = IndexFile {
            items: records.items.clone(),
        };
        let result = serde_json::to_vec_pretty(&file)
            .map_err(|err| err.to_string())
            .and_then(|bytes| {
                let tmp = self.index.with_extension("json.tmp");
                std::fs::write(&tmp, bytes)
                    .and_then(|()| std::fs::rename(&tmp, &self.index))
                    .map_err(|err| err.to_string())
            });
        if let Err(err) = result {
            log::warn!("保存下载记录失败：{err}");
        }
    }

    fn next_id(&self) -> String {
        let number = self.sequence.fetch_add(1, Ordering::SeqCst);
        format!("{}-{number}", now_ms())
    }

    /// 更新一项的进度或状态，并通知界面
    fn update(&self, id: &str, change: impl FnOnce(&mut Item)) {
        let view = {
            let mut records = lock(&self.records);
            let Some(item) = records.items.iter_mut().find(|item| item.id == id) else {
                return;
            };
            change(item);
            self.view(item)
        };
        self.emit(&view);
    }

    /// 结束一项：状态和错误信息写进记录，并通知界面
    fn finish(&self, id: &str, status: Status, error: Option<String>) {
        let view = {
            let mut records = lock(&self.records);
            records.cancels.remove(id);
            let Some(item) = records.items.iter_mut().find(|item| item.id == id) else {
                return;
            };
            item.status = status;
            item.error = error;
            let view = self.view(item);
            self.persist(&records);
            view
        };
        self.emit(&view);
    }

    /// 下载没有成功：删掉已经写了一半的文件，不留下残缺的视频
    fn discard(&self, id: &str) {
        if let Some(item) = self.snapshot(id) {
            self.delete_files(&item);
        }
    }

    fn delete_files(&self, item: &Item) {
        if !is_safe_id(&item.id) {
            return;
        }
        let results = match item.kind {
            // 分片文件夹，以及可能已经合成了一半的 MP4
            Kind::Hls => vec![
                std::fs::remove_dir_all(self.dir.join(&item.id)),
                std::fs::remove_file(self.dir.join(format!("{}.mp4", item.id))),
            ],
            Kind::File => vec![std::fs::remove_file(self.dir.join(&item.entry))],
        };
        for result in results {
            if let Err(err) = result {
                if err.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("删除下载文件失败：{err}");
                }
            }
        }
    }
}

/// 后台任务：下载，然后决定最终状态
async fn run(app: AppHandle, id: String, cancel: Arc<AtomicBool>) {
    let manager = app.state::<DownloadManager>();
    let result = download(&manager, &id, &cancel).await;
    if cancel.load(Ordering::SeqCst) {
        manager.discard(&id);
        manager.finish(&id, Status::Canceled, None);
        return;
    }
    match result {
        Ok(()) => {
            let title = manager
                .snapshot(&id)
                .map(|item| item.title)
                .unwrap_or_default();
            manager.finish(&id, Status::Done, None);
            notify(&app, &title);
        }
        Err(err) => {
            manager.discard(&id);
            manager.finish(&id, Status::Failed, Some(err));
        }
    }
}

/// 下载完成后发一条系统通知。没有通知权限时直接忽略，不影响下载。
fn notify(app: &AppHandle, title: &str) {
    let sent = app
        .notification()
        .builder()
        .title("下载完成")
        .body(title)
        .show();
    if let Err(err) = sent {
        log::info!("没有发出下载完成的通知：{err}");
    }
}

/// 先看地址和响应的类型，决定按 HLS 还是直链下载
async fn download(manager: &DownloadManager, id: &str, cancel: &AtomicBool) -> Result<(), String> {
    let item = manager.snapshot(id).ok_or("找不到这一项")?;
    let source = Url::parse(&item.source).map_err(|_| "视频地址格式不对".to_string())?;
    let client = http_client()?;
    let mut response = get(&client, &source).await?;
    let first = match response.chunk().await.map_err(network)? {
        Some(chunk) => chunk.to_vec(),
        None => Vec::new(),
    };
    if is_playlist_url(&source) || is_playlist_type(&response) || first.starts_with(b"#EXTM3U") {
        let body = read_rest(response, first, MAX_PLAYLIST_BYTES).await?;
        let text = String::from_utf8_lossy(&body).into_owned();
        manager.update(id, |item| {
            item.kind = Kind::Hls;
            item.entry = format!("{id}/index.m3u8");
        });
        let folder = manager.dir().join(id);
        let fetched = fetch_hls(&client, &source, &text, &folder, cancel, |done, total| {
            manager.update(id, |item| {
                item.done = done;
                item.total = total;
            });
        })
        .await?;
        return convert_hls(manager, id, &folder, fetched, cancel).await;
    }
    write_file(manager, id, cancel, response, first).await
}

/// 直链视频：边下载边写入文件
async fn write_file(
    manager: &DownloadManager,
    id: &str,
    cancel: &AtomicBool,
    mut response: reqwest::Response,
    first: Vec<u8>,
) -> Result<(), String> {
    if content_type(&response).is_some_and(|value| value.starts_with("text/html")) {
        return Err("这个地址返回的是网页，不是视频文件".into());
    }
    let length = response.content_length().unwrap_or(0);
    let item = manager.snapshot(id).ok_or("找不到这一项")?;
    let path = manager.dir().join(&item.entry);
    let mut file = tokio::fs::File::create(&path).await.map_err(write_error)?;
    manager.update(id, |item| item.total = length);

    let mut written = 0u64;
    let mut reported = 0u64;
    let mut next = Some(first);
    loop {
        let piece = match next.take() {
            Some(piece) => piece,
            None => match response.chunk().await.map_err(network)? {
                Some(chunk) => chunk.to_vec(),
                None => break,
            },
        };
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        if piece.is_empty() {
            continue;
        }
        file.write_all(&piece).await.map_err(write_error)?;
        written += piece.len() as u64;
        if written - reported >= PROGRESS_STEP {
            reported = written;
            manager.update(id, |item| item.done = written);
        }
    }
    file.flush().await.map_err(write_error)?;
    if written == 0 {
        return Err("视频内容是空的".into());
    }
    manager.update(id, |item| {
        item.done = written;
        item.total = written;
    });
    Ok(())
}

/// 分片下载的结果：文件个数（含 fMP4 的初始化分片）和是否是 fMP4
#[derive(Debug, Clone, Copy, PartialEq)]
struct Fetched {
    files: usize,
    fmp4: bool,
}

/// 分片合成一个 `<id>.mp4`：成功后这一项改成普通视频文件，删掉分片文件夹。
/// TS 编码不支持或内容异常时保留分片（应用内照样能播放），不算下载失败；fMP4 拼接失败才算失败。
async fn convert_hls(
    manager: &DownloadManager,
    id: &str,
    folder: &Path,
    fetched: Fetched,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    manager.update(id, |item| item.stage = Some(STAGE_CONVERTING.into()));
    let parts: Vec<PathBuf> = (0..fetched.files)
        .map(|index| folder.join(segment_file(index)))
        .collect();
    let out = manager.dir().join(format!("{id}.mp4"));
    let target = out.clone();
    let result = tokio::task::spawn_blocking(move || {
        if fetched.fmp4 {
            remux::concat_fmp4(&parts, &target).map(|()| None)
        } else {
            remux::ts_to_mp4(&parts, &target).map(Some)
        }
    })
    .await
    .map_err(|err| format!("合成 MP4 的任务出错：{err}"))?;
    manager.update(id, |item| item.stage = None);
    if cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    match result {
        Ok(stats) => {
            if let Some(stats) = stats {
                log::info!("已合成 MP4：{id}，{stats:?}");
            }
            let size = tokio::fs::metadata(&out)
                .await
                .map(|meta| meta.len())
                .unwrap_or(0);
            manager.update(id, |item| {
                item.kind = Kind::File;
                item.entry = format!("{id}.mp4");
                item.done = size;
                item.total = size;
            });
            if let Err(err) = tokio::fs::remove_dir_all(folder).await {
                log::warn!("删除分片文件夹失败：{err}");
            }
            Ok(())
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&out).await;
            if fetched.fmp4 {
                return Err(err.to_string());
            }
            log::warn!("没有合成 MP4，保留分片：{err}");
            Ok(())
        }
    }
}

/// 把 HLS 播放列表下载到 folder：选最高码率，解密分片，按顺序写成 00000.ts……，再写 index.m3u8
/// （合成 MP4 失败时应用内用它播放）。进度通过 progress(已完成分片数, 分片总数) 报告。
async fn fetch_hls(
    client: &reqwest::Client,
    source: &Url,
    text: &str,
    folder: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, u64),
) -> Result<Fetched, String> {
    let playlist = match hls::parse(text, source)? {
        Playlist::Master(variants) => {
            let best = hls::best_variant(variants).ok_or("播放列表里没有可用的画质")?;
            let body = fetch_bytes(client, &best.uri, MAX_PLAYLIST_BYTES).await?;
            hls::parse(&String::from_utf8_lossy(&body), &best.uri)?
        }
        media => media,
    };
    let Playlist::Media(segments) = playlist else {
        return Err("播放列表嵌套太多层，暂不支持".into());
    };
    if segments.is_empty() {
        return Err("播放列表里没有分片".into());
    }
    if segments.len() > MAX_SEGMENTS {
        return Err(format!("分片太多（{} 个），暂不支持", segments.len()));
    }

    tokio::fs::create_dir_all(folder)
        .await
        .map_err(write_error)?;
    let total = segments.len() as u64;
    let fmp4 = segments.first().is_some_and(|segment| segment.init);
    let durations: Vec<f64> = segments.iter().map(|segment| segment.duration).collect();
    let keys = Arc::new(fetch_keys(client, &segments).await?);
    progress(0, total);

    // buffered 保证结果按原来的顺序出来，写文件时不用再排序
    let mut decoded = stream::iter(segments)
        .map(move |segment| {
            let keys = Arc::clone(&keys);
            async move { fetch_segment(client, &segment, &keys).await }
        })
        .buffered(SEGMENT_PARALLELISM);

    let mut done = 0u64;
    while let Some(plain) = decoded.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        let plain = plain?;
        tokio::fs::write(folder.join(segment_file(done as usize)), &plain)
            .await
            .map_err(write_error)?;
        done += 1;
        progress(done, total);
    }
    write_local_playlist(folder, &durations, fmp4).await?;
    Ok(Fetched {
        files: done as usize,
        fmp4,
    })
}

/// 本地播放列表：只指向已经解密好的分片，不带任何密钥。fMP4 的第一个文件是初始化分片。
async fn write_local_playlist(folder: &Path, durations: &[f64], fmp4: bool) -> Result<(), String> {
    let target = durations.iter().copied().fold(1.0_f64, f64::max).ceil() as u64;
    let mut text = format!(
        "#EXTM3U\n#EXT-X-VERSION:{}\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n",
        if fmp4 { 7 } else { 3 }
    );
    let skip = usize::from(fmp4);
    if fmp4 {
        let _ = writeln!(text, "#EXT-X-MAP:URI=\"{}\"", segment_file(0));
    }
    for (index, duration) in durations.iter().enumerate().skip(skip) {
        let _ = writeln!(
            text,
            "#EXTINF:{:.3},\n{}",
            duration.max(0.001),
            segment_file(index)
        );
    }
    text.push_str("#EXT-X-ENDLIST\n");
    tokio::fs::write(folder.join("index.m3u8"), text)
        .await
        .map_err(write_error)
}

/// 同一个播放列表里的密钥通常只有一两个，每个地址只下载一次
async fn fetch_keys(
    client: &reqwest::Client,
    segments: &[Segment],
) -> Result<HashMap<String, [u8; 16]>, String> {
    let mut keys = HashMap::new();
    for key in segments.iter().filter_map(|segment| segment.key.as_ref()) {
        let name = key.uri.as_str().to_string();
        if keys.contains_key(&name) {
            continue;
        }
        let bytes = fetch_bytes(client, &key.uri, MAX_KEY_BYTES).await?;
        let secret: [u8; 16] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| "加密密钥的长度不对，应为 16 字节".to_string())?;
        keys.insert(name, secret);
    }
    Ok(keys)
}

async fn fetch_segment(
    client: &reqwest::Client,
    segment: &Segment,
    keys: &HashMap<String, [u8; 16]>,
) -> Result<Vec<u8>, String> {
    let body = fetch_bytes(client, &segment.uri, MAX_SEGMENT_BYTES).await?;
    let Some(key) = &segment.key else {
        return Ok(body);
    };
    let secret = keys.get(key.uri.as_str()).ok_or("缺少分片的解密密钥")?;
    let iv = key.iv.unwrap_or_else(|| hls::default_iv(segment.sequence));
    hls::decrypt_aes128(&body, secret, &iv)
}

fn http_client() -> Result<reqwest::Client, String> {
    crate::http::client_builder()
        .user_agent(servers::user_agent())
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|err| format!("无法创建网络连接：{err}"))
}

async fn get(client: &reqwest::Client, url: &Url) -> Result<reqwest::Response, String> {
    let response = client.get(url.clone()).send().await.map_err(network)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("服务器返回 {}，无法下载", status.as_u16()));
    }
    Ok(response)
}

async fn fetch_bytes(client: &reqwest::Client, url: &Url, limit: usize) -> Result<Vec<u8>, String> {
    let response = get(client, url).await?;
    read_rest(response, Vec::new(), limit).await
}

/// 读完剩下的内容；超过上限就放弃，避免内存被撑爆
async fn read_rest(
    mut response: reqwest::Response,
    mut body: Vec<u8>,
    limit: usize,
) -> Result<Vec<u8>, String> {
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if body.len() + chunk.len() > limit {
            return Err("内容太大，已放弃下载".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn content_type(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(CONTENT_TYPE)?
        .to_str()
        .ok()
        .map(|value| value.to_ascii_lowercase())
}

fn is_playlist_type(response: &reqwest::Response) -> bool {
    content_type(response).is_some_and(|value| value.contains("mpegurl"))
}

fn network(err: reqwest::Error) -> String {
    log::warn!("下载时网络出错：{err}");
    "网络出错，请检查网络后重试".into()
}

fn write_error(err: std::io::Error) -> String {
    log::warn!("写入下载文件失败：{err}");
    format!("写入文件失败（{err}）")
}

/// 检查下载地址：只接受 http 和 https，长度有上限。站点发来的地址也要经过这里。
pub(crate) fn parse_source(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("没有视频地址".into());
    }
    if raw.len() > MAX_URL_LEN {
        return Err("视频地址太长".into());
    }
    let url = Url::parse(raw).map_err(|_| "视频地址格式不对".to_string())?;
    if matches!(url.scheme(), "http" | "https") {
        Ok(url)
    } else {
        Err("只能下载 http 或 https 的视频地址".into())
    }
}

fn is_playlist_url(url: &Url) -> bool {
    url.path().to_ascii_lowercase().ends_with(".m3u8")
}

/// 直链视频的文件扩展名：取自地址，认不出来就按 mp4 保存
fn video_extension(url: &Url) -> &'static str {
    let name = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .unwrap_or_default();
    let ext = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    VIDEO_EXTENSIONS
        .into_iter()
        .find(|known| *known == ext)
        .unwrap_or("mp4")
}

fn entry_for(kind: Kind, id: &str, url: &Url) -> String {
    match kind {
        Kind::Hls => format!("{id}/index.m3u8"),
        Kind::File => format!("{id}.{}", video_extension(url)),
    }
}

fn clean_title(raw: Option<&str>) -> Option<String> {
    let title: String = raw?
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE_CHARS)
        .collect();
    let title = title.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn default_title(url: &Url) -> String {
    url.host_str()
        .map(|host| format!("来自 {host} 的视频"))
        .unwrap_or_else(|| "未命名视频".into())
}

/// 编号只允许数字和中划线，它会被用作文件夹名
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit() || c == '-')
}

fn segment_file(index: usize) -> String {
    format!("{index:05}.ts")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn download_list(manager: State<'_, DownloadManager>) -> Vec<View> {
    manager.list()
}

#[tauri::command]
pub fn download_start(
    manager: State<'_, DownloadManager>,
    url: String,
    title: Option<String>,
) -> Result<View, String> {
    manager.start(&url, title.as_deref())
}

#[tauri::command]
pub fn download_cancel(manager: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    manager.cancel(&id)
}

#[tauri::command]
pub fn download_delete(manager: State<'_, DownloadManager>, id: String) -> Result<(), String> {
    manager.remove(&id)
}

#[tauri::command]
pub fn download_open(
    app: AppHandle,
    manager: State<'_, DownloadManager>,
    id: String,
) -> Result<(), String> {
    let path = manager.entry_path(&id)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn download_folder(app: AppHandle, manager: State<'_, DownloadManager>) -> Result<(), String> {
    app.opener()
        .open_path(manager.dir().to_string_lossy(), None::<&str>)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn only_http_addresses_can_be_downloaded() {
        assert!(parse_source("https://cdn.example.com/a.mp4").is_ok());
        assert!(parse_source("  http://cdn.example.com/a.m3u8  ").is_ok());
        assert!(parse_source("").is_err());
        assert!(parse_source("file:///etc/passwd").is_err());
        assert!(parse_source("javascript:alert(1)").is_err());
        assert!(parse_source("not a url").is_err());
        let long = format!("https://a.example.com/{}", "x".repeat(MAX_URL_LEN));
        assert!(parse_source(&long).is_err());
    }

    #[test]
    fn file_extension_comes_from_the_address_and_defaults_to_mp4() {
        assert_eq!(
            video_extension(&url("https://a.example.com/x/movie.WEBM?t=1")),
            "webm"
        );
        assert_eq!(
            video_extension(&url("https://a.example.com/x/movie.exe")),
            "mp4"
        );
        assert_eq!(video_extension(&url("https://a.example.com/stream")), "mp4");
        assert!(is_playlist_url(&url(
            "https://a.example.com/index.M3U8?token=1"
        )));
        assert!(!is_playlist_url(&url("https://a.example.com/index.mp4")));
    }

    #[test]
    fn titles_are_trimmed_and_capped() {
        assert_eq!(
            clean_title(Some("  片名\u{0007} ")),
            Some("片名".to_string())
        );
        assert_eq!(clean_title(Some("   ")), None);
        assert_eq!(clean_title(None), None);
        let long = "字".repeat(500);
        assert_eq!(
            clean_title(Some(&long)).unwrap().chars().count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn ids_must_be_plain_digits_and_dashes() {
        assert!(is_safe_id("1762000000000-3"));
        assert!(!is_safe_id(""));
        assert!(!is_safe_id("../etc"));
        assert!(!is_safe_id("a b"));
        assert_eq!(segment_file(7), "00007.ts");
    }

    #[tokio::test]
    async fn local_playlist_lists_every_segment_with_its_duration() {
        let dir = std::env::temp_dir().join(format!("cktv-playlist-{}", now_ms()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        write_local_playlist(&dir, &[4.0, 3.5], false)
            .await
            .unwrap();
        let text = std::fs::read_to_string(dir.join("index.m3u8")).unwrap();
        assert!(text.starts_with("#EXTM3U\n"));
        assert!(text.contains("#EXT-X-TARGETDURATION:4\n"));
        assert!(text.contains("#EXTINF:4.000,\n00000.ts\n"));
        assert!(text.contains("#EXTINF:3.500,\n00001.ts\n"));
        assert!(text.ends_with("#EXT-X-ENDLIST\n"));
        assert!(!text.contains("KEY"));
        assert!(!text.contains("MAP"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn fmp4_local_playlist_points_at_the_init_section() {
        let dir = std::env::temp_dir().join(format!("cktv-playlist-fmp4-{}", now_ms()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        write_local_playlist(&dir, &[0.0, 4.0, 2.0], true)
            .await
            .unwrap();
        let text = std::fs::read_to_string(dir.join("index.m3u8")).unwrap();
        assert!(text.contains("#EXT-X-MAP:URI=\"00000.ts\"\n"));
        assert!(!text.contains("#EXTINF:0.001,\n00000.ts"));
        assert!(text.contains("#EXTINF:4.000,\n00001.ts\n"));
        assert!(text.contains("#EXTINF:2.000,\n00002.ts\n"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 测试用的本地服务器：按路径返回内容，每个连接只处理一个请求
    fn serve(routes: HashMap<String, Vec<u8>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 4096];
                let read = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = match routes.get(&path) {
                    Some(body) => ("200 OK", body.clone()),
                    None => ("404 Not Found", Vec::new()),
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn hls_download_picks_the_best_variant_and_decrypts_segments() {
        let key = [9u8; 16];
        let plain = [
            b"first segment".to_vec(),
            b"second segment, a bit longer".to_vec(),
        ];
        let mut routes = HashMap::new();
        // 只给了高码率的播放列表；如果误选了低码率，请求会 404，测试失败
        routes.insert(
            "/master.m3u8".to_string(),
            b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhigh.m3u8\n"
                .to_vec(),
        );
        routes.insert(
            "/high.m3u8".to_string(),
            b"#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI=\"/key.bin\"\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:3.5,\nseg1.ts\n#EXT-X-ENDLIST\n"
                .to_vec(),
        );
        routes.insert("/key.bin".to_string(), key.to_vec());
        for (index, data) in plain.iter().enumerate() {
            let iv = hls::default_iv(index as u64);
            let cipher = cbc::Encryptor::<aes::Aes128>::new_from_slices(&key, &iv)
                .unwrap()
                .encrypt_padded_vec_mut::<Pkcs7>(data);
            routes.insert(format!("/seg{index}.ts"), cipher);
        }
        let base = serve(routes);
        let source = Url::parse(&format!("{base}/master.m3u8")).unwrap();
        let master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nhigh.m3u8\n";

        let folder = std::env::temp_dir().join(format!("cktv-hls-{}", now_ms()));
        let client = reqwest::Client::new();
        let cancel = AtomicBool::new(false);
        let mut reports = Vec::new();
        let fetched = fetch_hls(&client, &source, master, &folder, &cancel, |done, total| {
            reports.push((done, total))
        })
        .await
        .unwrap();

        assert_eq!(
            fetched,
            Fetched {
                files: 2,
                fmp4: false
            }
        );
        assert_eq!(reports.last(), Some(&(2, 2)));
        assert_eq!(std::fs::read(folder.join("00000.ts")).unwrap(), plain[0]);
        assert_eq!(std::fs::read(folder.join("00001.ts")).unwrap(), plain[1]);
        let index = std::fs::read_to_string(folder.join("index.m3u8")).unwrap();
        assert!(index.contains("#EXTINF:4.000,\n00000.ts\n"));
        assert!(index.contains("#EXTINF:3.500,\n00001.ts\n"));
        assert!(!index.contains("KEY"));
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
