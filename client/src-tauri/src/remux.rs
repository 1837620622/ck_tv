//! 把下载好的 HLS 分片合成一个能直接播放的 MP4 文件。
//!
//! - TS 分片（最常见）：拆出 H.264 画面和 AAC 声音，不重新编码，直接装进 MP4。
//!   只是换个封装，速度快、画质不变。其它编码（H.265、MP3、AC-3 等）返回 [`Error::Unsupported`]，
//!   由调用方保留原来的分片文件夹（应用内照样能播放）。
//! - fMP4 分片（`#EXT-X-MAP`）：初始化分片加上所有分片按顺序拼起来，本身就是一个合法的 MP4。
//!
//! 时间戳的处理：
//! - 画面从第一个关键帧开始（之前的帧没有参考帧，解不出来）。
//! - 每一帧的时长取相邻两帧解码时间戳之差；差值异常（倒退、超过 5 秒，比如分片之间的时间戳跳变）时
//!   沿用上一个正常的时长。
//! - 声音以画面开始的时间对齐：比画面早的声音帧丢掉，比画面晚就在开头补静音帧（只支持单声道、双声道 AAC-LC），
//!   之后每帧固定 1024 个采样，不会越积越偏。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use bytes::Bytes;
use mp4::{
    AacConfig, AudioObjectType, AvcConfig, ChannelConfig, MediaConfig, Mp4Config, Mp4Sample,
    Mp4Writer, SampleFreqIndex, TrackConfig, TrackType,
};

/// TS 的时间单位：90kHz
const TS_CLOCK: u64 = 90_000;
/// 33 位时间戳的回绕周期
const PTS_WRAP: u64 = 1 << 33;
/// 帧时长异常时用的默认值：25 帧每秒
const DEFAULT_FRAME_TICKS: u32 = 3_600;
/// 两帧之间超过这么久，当作时间戳跳变
const MAX_FRAME_TICKS: u64 = 5 * TS_CLOCK;
/// 开头最多补多少秒静音，防止异常的时间戳生成一大段空白
const MAX_SILENCE_SECONDS: u64 = 10;
const TS_PACKET: usize = 188;

#[derive(Debug, PartialEq)]
pub enum Error {
    /// 编码不支持：调用方应保留原来的分片，不算下载失败
    Unsupported(String),
    /// 读写文件出错，或者分片内容不完整
    Failed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unsupported(text) | Error::Failed(text) => f.write_str(text),
        }
    }
}

fn io(err: std::io::Error) -> Error {
    Error::Failed(format!("合成 MP4 时读写文件出错：{err}"))
}

fn mp4_error(err: mp4::Error) -> Error {
    Error::Failed(format!("写入 MP4 出错：{err}"))
}

/// 合成结果：用于日志和测试
#[derive(Debug, Default, PartialEq)]
pub struct Stats {
    pub video_frames: u64,
    pub audio_frames: u64,
    pub silence_frames: u64,
}

/// fMP4：初始化分片和媒体分片按顺序拼接
pub fn concat_fmp4(parts: &[PathBuf], out: &Path) -> Result<(), Error> {
    let mut writer = BufWriter::new(File::create(out).map_err(io)?);
    for part in parts {
        let mut reader = File::open(part).map_err(io)?;
        std::io::copy(&mut reader, &mut writer).map_err(io)?;
    }
    writer.flush().map_err(io)
}

/// TS 分片（按播放顺序）合成一个 MP4
pub fn ts_to_mp4(segments: &[PathBuf], out: &Path) -> Result<Stats, Error> {
    let probe = probe(segments)?;
    let file = File::create(out).map_err(io)?;
    let config = Mp4Config {
        major_brand: "isom".parse().expect("固定的四字符"),
        minor_version: 512,
        compatible_brands: ["isom", "iso2", "avc1", "mp41"]
            .iter()
            .map(|brand| brand.parse().expect("固定的四字符"))
            .collect(),
        timescale: 1000,
    };
    let mut writer = Mp4Writer::write_start(BufWriter::new(file), &config).map_err(mp4_error)?;
    let mut muxer = Muxer::new(&probe, &mut writer)?;
    let mut demuxer = Demuxer::default();
    for segment in segments {
        let data = read_file(segment)?;
        demuxer.push(&data, &mut |pes| muxer.on_pes(pes))?;
    }
    demuxer.finish(&mut |pes| muxer.on_pes(pes))?;
    let stats = muxer.finish()?;
    writer.write_end().map_err(mp4_error)?;
    writer.into_writer().flush().map_err(io)?;
    if stats.video_frames == 0 && stats.audio_frames == 0 {
        return Err(Error::Failed("分片里没有找到画面和声音".into()));
    }
    Ok(stats)
}

fn read_file(path: &Path) -> Result<Vec<u8>, Error> {
    let mut data = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut data))
        .map_err(io)?;
    Ok(data)
}

/* ---------------- 第一遍：找出编码参数 ---------------- */

#[derive(Debug, Default, Clone)]
struct Probe {
    video: Option<VideoInfo>,
    audio: Option<AudioInfo>,
    has_video_stream: bool,
    has_audio_stream: bool,
}

#[derive(Debug, Clone)]
struct VideoInfo {
    sps: Vec<u8>,
    pps: Vec<u8>,
    width: u16,
    height: u16,
    /// 第一个关键帧的解码时间戳（已处理回绕）
    start: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct AudioInfo {
    object_type: u8,
    freq_index: u8,
    sample_rate: u32,
    channels: u8,
    /// 第一帧声音的显示时间戳（已处理回绕）
    start: u64,
}

#[derive(Default)]
struct ProbeState {
    found: Probe,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    video_clock: Unwrap,
    audio_clock: Unwrap,
    unsupported: Option<String>,
}

impl ProbeState {
    fn feed(&mut self, pes: Pes) -> Result<(), Error> {
        match pes.stream_type {
            STREAM_H264 => {
                self.found.has_video_stream = true;
                let mut keyframe = false;
                for nal in annexb_units(&pes.data) {
                    match nal.first().map(|b| b & 0x1f) {
                        Some(7) if self.sps.is_none() => self.sps = Some(nal.to_vec()),
                        Some(8) if self.pps.is_none() => self.pps = Some(nal.to_vec()),
                        Some(5) => keyframe = true,
                        _ => {}
                    }
                }
                if self.found.video.is_none() && keyframe {
                    if let (Some(sps), Some(pps), Some(time)) =
                        (self.sps.as_ref(), self.pps.as_ref(), pes.dts.or(pes.pts))
                    {
                        let (width, height) = sps_dimensions(sps)
                            .ok_or_else(|| Error::Failed("画面参数（SPS）解析失败".into()))?;
                        self.found.video = Some(VideoInfo {
                            sps: sps.clone(),
                            pps: pps.clone(),
                            width,
                            height,
                            start: self.video_clock.unwrap(time),
                        });
                    }
                }
            }
            STREAM_AAC => {
                self.found.has_audio_stream = true;
                if self.found.audio.is_none() {
                    if let (Some(header), Some(pts)) = (AdtsHeader::parse(&pes.data), pes.pts) {
                        self.found.audio = Some(AudioInfo {
                            object_type: header.object_type,
                            freq_index: header.freq_index,
                            sample_rate: header.sample_rate,
                            channels: header.channels,
                            start: self.audio_clock.unwrap(pts),
                        });
                    }
                }
            }
            other => {
                self.unsupported
                    .get_or_insert_with(|| describe_stream(other));
            }
        }
        Ok(())
    }

    fn ready(&self) -> bool {
        let found = &self.found;
        let video_ready = found.video.is_some() || !found.has_video_stream;
        let audio_ready = found.audio.is_some() || !found.has_audio_stream;
        (found.has_video_stream || found.has_audio_stream) && video_ready && audio_ready
    }
}

/// 读前面几个分片，直到找到画面的 SPS/PPS 和第一个关键帧、声音的第一个 ADTS 帧头
fn probe(segments: &[PathBuf]) -> Result<Probe, Error> {
    let mut state = ProbeState::default();
    let mut demuxer = Demuxer::default();
    for segment in segments {
        let data = read_file(segment)?;
        demuxer.push(&data, &mut |pes| state.feed(pes))?;
        if state.ready() {
            break;
        }
    }
    if let Some(reason) = state.unsupported {
        return Err(Error::Unsupported(reason));
    }
    let found = state.found;
    if !found.has_video_stream && !found.has_audio_stream {
        return Err(Error::Unsupported(
            "分片里没有找到 H.264 画面或 AAC 声音".into(),
        ));
    }
    if found.has_video_stream && found.video.is_none() {
        return Err(Error::Failed("没有找到画面的关键帧和编码参数".into()));
    }
    if found.has_audio_stream && found.audio.is_none() {
        return Err(Error::Failed("没有找到声音的编码参数".into()));
    }
    Ok(found)
}

fn describe_stream(stream_type: u8) -> String {
    let name = match stream_type {
        0x24 => "H.265 (HEVC)",
        0x03 | 0x04 => "MP3",
        0x81 => "AC-3",
        0x87 => "E-AC-3",
        0x1b => "H.264",
        0x0f => "AAC",
        _ => "未知",
    };
    format!("编码 {name}（0x{stream_type:02x}）暂不支持合成 MP4")
}

/* ---------------- 第二遍：写入 MP4 ---------------- */

struct Muxer<'a, W: Write + std::io::Seek> {
    writer: &'a mut Mp4Writer<W>,
    video: Option<VideoTrack>,
    audio: Option<AudioTrack>,
    stats: Stats,
}

struct VideoTrack {
    id: u32,
    clock: Unwrap,
    started: bool,
    pending: Option<PendingFrame>,
    last_duration: u32,
}

struct PendingFrame {
    dts: u64,
    offset: i32,
    sync: bool,
    bytes: Vec<u8>,
}

struct AudioTrack {
    id: u32,
    info: AudioInfo,
    clock: Unwrap,
    /// 画面开始的时间；没有画面时是声音自己的开始时间
    anchor: u64,
    started: bool,
    rest: Vec<u8>,
}

impl<'a, W: Write + std::io::Seek> Muxer<'a, W> {
    fn new(probe: &Probe, writer: &'a mut Mp4Writer<W>) -> Result<Self, Error> {
        let mut next_id = 1;
        let video = match &probe.video {
            Some(info) => {
                writer
                    .add_track(&TrackConfig {
                        track_type: TrackType::Video,
                        timescale: TS_CLOCK as u32,
                        language: "und".into(),
                        media_conf: MediaConfig::AvcConfig(AvcConfig {
                            width: info.width,
                            height: info.height,
                            seq_param_set: info.sps.clone(),
                            pic_param_set: info.pps.clone(),
                        }),
                    })
                    .map_err(mp4_error)?;
                let id = next_id;
                next_id += 1;
                Some(VideoTrack {
                    id,
                    clock: Unwrap::default(),
                    started: false,
                    pending: None,
                    last_duration: DEFAULT_FRAME_TICKS,
                })
            }
            None => None,
        };
        let audio = match &probe.audio {
            Some(info) => {
                let config = AacConfig {
                    bitrate: 128_000,
                    profile: AudioObjectType::try_from(info.object_type)
                        .map_err(|_| Error::Unsupported("AAC 类型暂不支持".into()))?,
                    freq_index: SampleFreqIndex::try_from(info.freq_index)
                        .map_err(|_| Error::Unsupported("AAC 采样率暂不支持".into()))?,
                    chan_conf: ChannelConfig::try_from(info.channels)
                        .map_err(|_| Error::Unsupported("AAC 声道数暂不支持".into()))?,
                };
                writer
                    .add_track(&TrackConfig {
                        track_type: TrackType::Audio,
                        timescale: info.sample_rate,
                        language: "und".into(),
                        media_conf: MediaConfig::AacConfig(config),
                    })
                    .map_err(mp4_error)?;
                Some(AudioTrack {
                    id: next_id,
                    info: *info,
                    clock: Unwrap::default(),
                    anchor: probe.video.as_ref().map_or(info.start, |video| video.start),
                    started: false,
                    rest: Vec::new(),
                })
            }
            None => None,
        };
        Ok(Self {
            writer,
            video,
            audio,
            stats: Stats::default(),
        })
    }

    fn on_pes(&mut self, pes: Pes) -> Result<(), Error> {
        match pes.stream_type {
            STREAM_H264 => self.on_video(pes),
            STREAM_AAC => self.on_audio(pes),
            _ => Ok(()),
        }
    }

    fn on_video(&mut self, pes: Pes) -> Result<(), Error> {
        let Some(track) = self.video.as_mut() else {
            return Ok(());
        };
        let Some(raw_dts) = pes.dts.or(pes.pts) else {
            return Ok(());
        };
        let dts = track.clock.unwrap(raw_dts);
        let pts = pes.pts.map_or(dts, |pts| track.clock.near(pts, dts));
        let mut bytes = Vec::with_capacity(pes.data.len() + 16);
        let mut sync = false;
        for nal in annexb_units(&pes.data) {
            let kind = nal[0] & 0x1f;
            // 访问单元分隔符、SPS、PPS 已经写在文件头里，不再放进每一帧
            if matches!(kind, 7..=9) {
                continue;
            }
            sync |= kind == 5;
            bytes.extend_from_slice(&(nal.len() as u32).to_be_bytes());
            bytes.extend_from_slice(nal);
        }
        if bytes.is_empty() {
            return Ok(());
        }
        if !track.started {
            if !sync {
                return Ok(());
            }
            track.started = true;
        }
        let frame = PendingFrame {
            dts,
            offset: i32::try_from(pts.saturating_sub(dts)).unwrap_or(0),
            sync,
            bytes,
        };
        if let Some(previous) = track.pending.replace(frame) {
            let delta = dts.wrapping_sub(previous.dts);
            if dts > previous.dts && delta <= MAX_FRAME_TICKS {
                track.last_duration = delta as u32;
            }
            let duration = track.last_duration;
            write_video(self.writer, track.id, previous, duration)?;
            self.stats.video_frames += 1;
        }
        Ok(())
    }

    fn on_audio(&mut self, pes: Pes) -> Result<(), Error> {
        let Some(track) = self.audio.as_mut() else {
            return Ok(());
        };
        let frame_ticks = 1024 * TS_CLOCK / u64::from(track.info.sample_rate);
        let mut data = std::mem::take(&mut track.rest);
        data.extend_from_slice(&pes.data);
        let mut pts = pes.pts.map(|pts| track.clock.unwrap(pts));
        let mut at = 0;
        while at + 7 <= data.len() {
            let Some(header) = AdtsHeader::parse(&data[at..]) else {
                // 不是帧头：往后找下一个同步字
                at += 1;
                continue;
            };
            if at + header.frame_length > data.len() {
                break;
            }
            let payload = &data[at + header.header_length..at + header.frame_length];
            at += header.frame_length;
            let frame_pts = pts;
            pts = pts.map(|value| value + frame_ticks * u64::from(header.blocks));

            if !track.started {
                let Some(frame_pts) = frame_pts else { continue };
                // 比画面早超过半帧的声音丢掉
                if frame_pts + frame_ticks / 2 < track.anchor {
                    continue;
                }
                track.started = true;
                // 比画面晚：开头补静音
                let gap = frame_pts.saturating_sub(track.anchor);
                let count = ((gap + frame_ticks / 2) / frame_ticks)
                    .min(MAX_SILENCE_SECONDS * TS_CLOCK / frame_ticks);
                if let Some(silence) = silent_frame(&track.info) {
                    for _ in 0..count {
                        write_audio(self.writer, track.id, silence.to_vec(), 1024)?;
                        self.stats.silence_frames += 1;
                    }
                }
            }
            write_audio(
                self.writer,
                track.id,
                payload.to_vec(),
                1024 * u32::from(header.blocks),
            )?;
            self.stats.audio_frames += 1;
        }
        track.rest = data[at..].to_vec();
        Ok(())
    }

    fn finish(mut self) -> Result<Stats, Error> {
        if let Some(track) = self.video.as_mut() {
            if let Some(last) = track.pending.take() {
                write_video(self.writer, track.id, last, track.last_duration)?;
                self.stats.video_frames += 1;
            }
        }
        Ok(self.stats)
    }
}

fn write_video<W: Write + std::io::Seek>(
    writer: &mut Mp4Writer<W>,
    track: u32,
    frame: PendingFrame,
    duration: u32,
) -> Result<(), Error> {
    writer
        .write_sample(
            track,
            &Mp4Sample {
                start_time: 0,
                duration,
                rendering_offset: frame.offset,
                is_sync: frame.sync,
                bytes: Bytes::from(frame.bytes),
            },
        )
        .map_err(mp4_error)
}

fn write_audio<W: Write + std::io::Seek>(
    writer: &mut Mp4Writer<W>,
    track: u32,
    payload: Vec<u8>,
    duration: u32,
) -> Result<(), Error> {
    writer
        .write_sample(
            track,
            &Mp4Sample {
                start_time: 0,
                duration,
                rendering_offset: 0,
                is_sync: true,
                bytes: Bytes::from(payload),
            },
        )
        .map_err(mp4_error)
}

/// AAC-LC 的静音帧（和 hls.js 用的相同）
fn silent_frame(info: &AudioInfo) -> Option<&'static [u8]> {
    if info.object_type != 2 {
        return None;
    }
    match info.channels {
        1 => Some(&[0x00, 0xc8, 0x00, 0x80, 0x23, 0x80]),
        2 => Some(&[0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80]),
        _ => None,
    }
}

/* ---------------- 时间戳回绕 ---------------- */

/// 33 位时间戳大约 26.5 小时回绕一次；把它展开成单调的 64 位数
#[derive(Default)]
struct Unwrap {
    last: Option<u64>,
}

impl Unwrap {
    fn unwrap(&mut self, raw: u64) -> u64 {
        let value = match self.last {
            None => raw,
            Some(last) => closest(raw, last),
        };
        self.last = Some(value);
        value
    }

    /// 和 reference 同一轮的值（PTS 和 DTS 相差不大，按 DTS 展开 PTS）
    fn near(&self, raw: u64, reference: u64) -> u64 {
        closest(raw, reference)
    }
}

/// raw 加上若干个回绕周期，取最接近 reference 的那个
fn closest(raw: u64, reference: u64) -> u64 {
    let base = reference - reference % PTS_WRAP;
    [base.wrapping_sub(PTS_WRAP), base, base + PTS_WRAP]
        .into_iter()
        .filter(|epoch| *epoch <= u64::MAX - PTS_WRAP)
        .map(|epoch| epoch + raw)
        .min_by_key(|candidate| candidate.abs_diff(reference))
        .unwrap_or(raw)
}

/* ---------------- TS 解复用 ---------------- */

const STREAM_H264: u8 = 0x1b;
const STREAM_AAC: u8 = 0x0f;

#[derive(Debug)]
struct Pes {
    stream_type: u8,
    pts: Option<u64>,
    dts: Option<u64>,
    data: Vec<u8>,
}

#[derive(Default)]
struct Demuxer {
    pmt_pid: Option<u16>,
    /// 节目里的各路流：PID → 流类型
    streams: HashMap<u16, u8>,
    /// 正在拼接的 PES：PID → 数据
    pending: HashMap<u16, Vec<u8>>,
}

impl Demuxer {
    fn push(
        &mut self,
        data: &[u8],
        out: &mut impl FnMut(Pes) -> Result<(), Error>,
    ) -> Result<(), Error> {
        // 有的分片前面加了几百字节的假图片头，从第一个连续的同步字开始读
        let mut at = find_sync(data).unwrap_or(data.len());
        while at + TS_PACKET <= data.len() {
            if data[at] != 0x47 {
                match find_sync(&data[at..]) {
                    Some(offset) => {
                        at += offset;
                        continue;
                    }
                    None => break,
                }
            }
            self.packet(&data[at..at + TS_PACKET], out)?;
            at += TS_PACKET;
        }
        Ok(())
    }

    fn packet(
        &mut self,
        packet: &[u8],
        out: &mut impl FnMut(Pes) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let pid = (u16::from(packet[1] & 0x1f) << 8) | u16::from(packet[2]);
        let start = packet[1] & 0x40 != 0;
        let control = (packet[3] >> 4) & 0x3;
        if control & 0x1 == 0 {
            return Ok(());
        }
        let mut offset = 4;
        if control & 0x2 != 0 {
            offset += 1 + usize::from(packet[4]);
        }
        if offset >= TS_PACKET {
            return Ok(());
        }
        let payload = &packet[offset..];

        if pid == 0 {
            if start {
                self.read_pat(payload);
            }
        } else if Some(pid) == self.pmt_pid {
            if start {
                self.read_pmt(payload);
            }
        } else if let Some(&stream_type) = self.streams.get(&pid) {
            if start {
                if let Some(done) = self.pending.remove(&pid) {
                    if let Some(pes) = parse_pes(stream_type, &done) {
                        out(pes)?;
                    }
                }
                self.pending.insert(pid, payload.to_vec());
            } else if let Some(buffer) = self.pending.get_mut(&pid) {
                buffer.extend_from_slice(payload);
            }
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut impl FnMut(Pes) -> Result<(), Error>) -> Result<(), Error> {
        // 按 PID 排序，结果稳定
        let mut left: Vec<(u16, Vec<u8>)> = self.pending.drain().collect();
        left.sort_by_key(|(pid, _)| *pid);
        for (pid, data) in left {
            if let Some(&stream_type) = self.streams.get(&pid) {
                if let Some(pes) = parse_pes(stream_type, &data) {
                    out(pes)?;
                }
            }
        }
        Ok(())
    }

    fn read_pat(&mut self, payload: &[u8]) {
        let Some(section) = psi_section(payload, 0x00) else {
            return;
        };
        // 节目表：每 4 字节一项，节目号为 0 的是网络信息表，跳过
        for entry in section.chunks_exact(4) {
            let program = u16::from_be_bytes([entry[0], entry[1]]);
            if program != 0 {
                self.pmt_pid = Some((u16::from(entry[2] & 0x1f) << 8) | u16::from(entry[3]));
                return;
            }
        }
    }

    fn read_pmt(&mut self, payload: &[u8]) {
        let Some(section) = psi_section(payload, 0x02) else {
            return;
        };
        if section.len() < 4 {
            return;
        }
        let info_length = (usize::from(section[2] & 0x0f) << 8) | usize::from(section[3]);
        let mut at = 4 + info_length;
        while at + 5 <= section.len() {
            let stream_type = section[at];
            let pid = (u16::from(section[at + 1] & 0x1f) << 8) | u16::from(section[at + 2]);
            let es_length =
                (usize::from(section[at + 3] & 0x0f) << 8) | usize::from(section[at + 4]);
            self.streams.insert(pid, stream_type);
            at += 5 + es_length;
        }
    }
}

/// 第一个后面紧跟着同步字的位置（连续三个包都以 0x47 开头才算）
fn find_sync(data: &[u8]) -> Option<usize> {
    (0..data.len()).find(|&at| {
        data[at] == 0x47
            && (at + TS_PACKET >= data.len() || data[at + TS_PACKET] == 0x47)
            && (at + 2 * TS_PACKET >= data.len() || data[at + 2 * TS_PACKET] == 0x47)
    })
}

/// PSI 表的内容：跳过 pointer_field，检查表号，去掉表头（8 字节）和末尾的 CRC
fn psi_section(payload: &[u8], table_id: u8) -> Option<&[u8]> {
    let pointer = usize::from(*payload.first()?);
    let table = payload.get(1 + pointer..)?;
    if table.len() < 8 || table[0] != table_id {
        return None;
    }
    let length = (usize::from(table[1] & 0x0f) << 8) | usize::from(table[2]);
    let end = (3 + length).checked_sub(4)?;
    table.get(8..end.min(table.len()))
}

fn parse_pes(stream_type: u8, data: &[u8]) -> Option<Pes> {
    if data.len() < 9 || data[0..3] != [0, 0, 1] {
        return None;
    }
    let flags = data[7] >> 6;
    let header_length = usize::from(data[8]);
    let body = data.get(9 + header_length..)?;
    let pts = if flags & 0x2 != 0 {
        read_timestamp(data.get(9..14)?)
    } else {
        None
    };
    let dts = if flags == 0x3 {
        read_timestamp(data.get(14..19)?)
    } else {
        None
    };
    Some(Pes {
        stream_type,
        pts,
        dts,
        data: body.to_vec(),
    })
}

fn read_timestamp(bytes: &[u8]) -> Option<u64> {
    if bytes.len() < 5 {
        return None;
    }
    Some(
        (u64::from(bytes[0] >> 1 & 0x07) << 30)
            | (u64::from(bytes[1]) << 22)
            | (u64::from(bytes[2] >> 1) << 15)
            | (u64::from(bytes[3]) << 7)
            | u64::from(bytes[4] >> 1),
    )
}

/* ---------------- H.264 ---------------- */

/// 按起始码（00 00 01 / 00 00 00 01）拆出 NAL 单元
fn annexb_units(data: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = Vec::new();
    let mut at = 0;
    while at + 3 <= data.len() {
        if data[at] == 0 && data[at + 1] == 0 && data[at + 2] == 1 {
            starts.push(at + 3);
            at += 3;
        } else {
            at += 1;
        }
    }
    let ends: Vec<usize> = starts
        .iter()
        .skip(1)
        .map(|&next| {
            // 下一个起始码之前的 00（四字节起始码多出来的那个）不属于这个单元
            let mut end = next - 3;
            while end > 0 && data[end - 1] == 0 {
                end -= 1;
            }
            end
        })
        .chain(std::iter::once(data.len()))
        .collect();
    starts
        .into_iter()
        .zip(ends)
        .filter(|(start, end)| end > start)
        .map(move |(start, end)| &data[start..end])
}

/// 从 SPS 读出画面宽高（像素，已扣除裁边）
fn sps_dimensions(nal: &[u8]) -> Option<(u16, u16)> {
    let rbsp = remove_emulation_prevention(nal.get(1..)?);
    let mut bits = Bits::new(&rbsp);
    let profile = bits.read(8)?;
    bits.read(16)?; // 约束标志和级别
    bits.ue()?; // seq_parameter_set_id
    let mut chroma_format = 1;
    let mut separate_planes = false;
    if matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        chroma_format = bits.ue()?;
        if chroma_format == 3 {
            separate_planes = bits.read(1)? == 1;
        }
        bits.ue()?; // bit_depth_luma_minus8
        bits.ue()?; // bit_depth_chroma_minus8
        bits.read(1)?; // qpprime_y_zero_transform_bypass_flag
        if bits.read(1)? == 1 {
            let lists = if chroma_format == 3 { 12 } else { 8 };
            for index in 0..lists {
                if bits.read(1)? == 1 {
                    let size = if index < 6 { 16 } else { 64 };
                    let mut last = 8i64;
                    let mut next = 8i64;
                    for _ in 0..size {
                        if next != 0 {
                            next = (last + bits.se()? + 256) % 256;
                        }
                        if next != 0 {
                            last = next;
                        }
                    }
                }
            }
        }
    }
    bits.ue()?; // log2_max_frame_num_minus4
    match bits.ue()? {
        0 => {
            bits.ue()?;
        }
        1 => {
            bits.read(1)?;
            bits.se()?;
            bits.se()?;
            for _ in 0..bits.ue()? {
                bits.se()?;
            }
        }
        _ => {}
    }
    bits.ue()?; // max_num_ref_frames
    bits.read(1)?; // gaps_in_frame_num_value_allowed_flag
    let width_mbs = bits.ue()? + 1;
    let height_units = bits.ue()? + 1;
    let frame_mbs_only = bits.read(1)?;
    if frame_mbs_only == 0 {
        bits.read(1)?; // mb_adaptive_frame_field_flag
    }
    bits.read(1)?; // direct_8x8_inference_flag
    let (mut left, mut right, mut top, mut bottom) = (0, 0, 0, 0);
    if bits.read(1)? == 1 {
        left = bits.ue()?;
        right = bits.ue()?;
        top = bits.ue()?;
        bottom = bits.ue()?;
    }
    let field_factor = 2 - frame_mbs_only;
    let (unit_x, unit_y) = if chroma_format == 0 || separate_planes {
        (1, field_factor)
    } else {
        let sub_width = if chroma_format == 3 { 1 } else { 2 };
        let sub_height = if chroma_format == 1 { 2 } else { 1 };
        (sub_width, sub_height * field_factor)
    };
    let width = width_mbs * 16 - unit_x * (left + right);
    let height = field_factor * height_units * 16 - unit_y * (top + bottom);
    Some((u16::try_from(width).ok()?, u16::try_from(height).ok()?))
}

fn remove_emulation_prevention(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut zeros = 0;
    for &byte in data {
        if zeros >= 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
        out.push(byte);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    position: usize,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, position: 0 }
    }

    fn read(&mut self, count: u32) -> Option<u64> {
        let mut value = 0u64;
        for _ in 0..count {
            let byte = *self.data.get(self.position / 8)?;
            let bit = (byte >> (7 - self.position % 8)) & 1;
            value = (value << 1) | u64::from(bit);
            self.position += 1;
        }
        Some(value)
    }

    /// 无符号指数哥伦布码
    fn ue(&mut self) -> Option<u64> {
        let mut zeros = 0;
        while self.read(1)? == 0 {
            zeros += 1;
            if zeros > 32 {
                return None;
            }
        }
        Some((1u64 << zeros) - 1 + self.read(zeros)?)
    }

    /// 有符号指数哥伦布码
    fn se(&mut self) -> Option<i64> {
        let value = self.ue()? as i64;
        Some(if value % 2 == 1 {
            (value + 1) / 2
        } else {
            -(value / 2)
        })
    }
}

/* ---------------- AAC ---------------- */

#[derive(Debug, Clone, Copy, PartialEq)]
struct AdtsHeader {
    object_type: u8,
    freq_index: u8,
    sample_rate: u32,
    channels: u8,
    header_length: usize,
    frame_length: usize,
    /// 这一帧里有几个原始数据块（每块 1024 个采样），通常是 1
    blocks: u8,
}

const SAMPLE_RATES: [u32; 13] = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    7_350,
];

impl AdtsHeader {
    fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < 7 || data[0] != 0xff || data[1] & 0xf6 != 0xf0 {
            return None;
        }
        let protection_absent = data[1] & 0x01 == 1;
        let object_type = ((data[2] >> 6) & 0x03) + 1;
        let freq_index = (data[2] >> 2) & 0x0f;
        let channels = ((data[2] & 0x01) << 2) | (data[3] >> 6);
        let frame_length = (usize::from(data[3] & 0x03) << 11)
            | (usize::from(data[4]) << 3)
            | usize::from(data[5] >> 5);
        let header_length = if protection_absent { 7 } else { 9 };
        let sample_rate = *SAMPLE_RATES.get(usize::from(freq_index))?;
        if frame_length <= header_length || channels == 0 {
            return None;
        }
        Some(Self {
            object_type,
            freq_index,
            sample_rate,
            channels,
            header_length,
            frame_length,
            blocks: (data[6] & 0x03) + 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_read_from_pes_headers() {
        // PTS = 0x1_2345_6789（33 位），按 PES 的格式编码
        let value: u64 = 0x1_2345_6789;
        let bytes = [
            0x21 | (((value >> 30) as u8 & 0x07) << 1),
            (value >> 22) as u8,
            (((value >> 15) as u8) << 1) | 1,
            (value >> 7) as u8,
            ((value as u8) << 1) | 1,
        ];
        assert_eq!(read_timestamp(&bytes), Some(value));
    }

    #[test]
    fn wrapped_timestamps_keep_increasing() {
        let mut clock = Unwrap::default();
        assert_eq!(clock.unwrap(PTS_WRAP - 3_000), PTS_WRAP - 3_000);
        assert_eq!(clock.unwrap(600), PTS_WRAP + 600);
        assert_eq!(clock.unwrap(4_200), PTS_WRAP + 4_200);
        // B 帧的 PTS 略小于上一帧的也不会被当成回绕
        assert_eq!(clock.near(1_000, PTS_WRAP + 4_200), PTS_WRAP + 1_000);
    }

    #[test]
    fn annexb_units_split_on_three_and_four_byte_start_codes() {
        let data = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9,
        ];
        let units: Vec<&[u8]> = annexb_units(&data).collect();
        assert_eq!(
            units,
            vec![&[0x67, 1, 2][..], &[0x68, 3][..], &[0x65, 9][..]]
        );
    }

    #[test]
    fn emulation_prevention_bytes_are_removed() {
        assert_eq!(
            remove_emulation_prevention(&[0, 0, 3, 1, 0, 0, 3]),
            vec![0, 0, 1, 0, 0]
        );
    }

    #[test]
    fn adts_headers_describe_aac_frames() {
        // AAC-LC，44.1kHz（索引 4），双声道，帧长 371，无 CRC
        let header = [0xff, 0xf1, 0x50, 0x80, 0x2e, 0x7f, 0xfc];
        let parsed = AdtsHeader::parse(&header).unwrap();
        assert_eq!(parsed.object_type, 2);
        assert_eq!(parsed.sample_rate, 44_100);
        assert_eq!(parsed.channels, 2);
        assert_eq!(parsed.header_length, 7);
        assert_eq!(parsed.frame_length, 371);
        assert_eq!(parsed.blocks, 1);
        assert!(AdtsHeader::parse(&[0x47, 0, 0, 0, 0, 0, 0]).is_none());
    }

    fn fixture_segments() -> Vec<PathBuf> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/remux");
        // 扩展名用 .m2ts（同样是 MPEG-TS），免得被当成 TypeScript 去做代码检查
        vec![dir.join("000.m2ts"), dir.join("001.m2ts")]
    }

    fn temp_file(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("cktv-remux-{stamp}-{name}"))
    }

    /// 真实的 TS 分片（ffmpeg 生成：64×64、10 帧每秒、High 档次带 B 帧、22.05kHz 单声道 AAC，两段各 1 秒）
    /// 合成后再用 mp4 库读回来：两条轨道、帧数、尺寸、时长都对
    #[test]
    fn ts_segments_become_a_playable_mp4() {
        let out = temp_file("fixture.mp4");
        let stats = ts_to_mp4(&fixture_segments(), &out).unwrap();
        assert_eq!(stats.video_frames, 20);
        assert!(stats.audio_frames > 30, "{stats:?}");

        let size = std::fs::metadata(&out).unwrap().len();
        let reader =
            mp4::Mp4Reader::read_header(std::io::BufReader::new(File::open(&out).unwrap()), size)
                .unwrap();
        let mut video = None;
        let mut audio = None;
        for track in reader.tracks().values() {
            match track.track_type().unwrap() {
                TrackType::Video => video = Some(track),
                TrackType::Audio => audio = Some(track),
                TrackType::Subtitle => {}
            }
        }
        let video = video.expect("有画面轨道");
        assert_eq!((video.width(), video.height()), (64, 64));
        assert_eq!(video.sample_count(), 20);
        assert_eq!(video.media_type().unwrap(), mp4::MediaType::H264);
        let seconds = video.duration().as_secs_f64();
        assert!((seconds - 2.0).abs() < 0.11, "画面时长 {seconds}");
        let audio = audio.expect("有声音轨道");
        assert_eq!(audio.media_type().unwrap(), mp4::MediaType::AAC);
        assert_eq!(audio.sample_freq_index().unwrap().freq(), 22_050);
        std::fs::remove_file(out).ok();
    }

    #[test]
    fn junk_before_the_first_packet_is_skipped() {
        // 有的线路在 TS 分片前面加一段假的图片头
        let dir = temp_file("junk");
        std::fs::create_dir_all(&dir).unwrap();
        let mut parts = Vec::new();
        for (index, segment) in fixture_segments().iter().enumerate() {
            let mut data = b"\x89PNG\r\n\x1a\n fake header".to_vec();
            data.extend(std::fs::read(segment).unwrap());
            let path = dir.join(format!("{index}.ts"));
            std::fs::write(&path, data).unwrap();
            parts.push(path);
        }
        let stats = ts_to_mp4(&parts, &dir.join("out.mp4")).unwrap();
        assert_eq!(stats.video_frames, 20);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn files_that_are_not_ts_are_rejected() {
        let dir = temp_file("garbage");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("0.ts");
        std::fs::write(&path, b"<html>403 Forbidden</html>").unwrap();
        assert!(matches!(
            ts_to_mp4(&[path], &dir.join("out.mp4")),
            Err(Error::Unsupported(_))
        ));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn sps_gives_the_cropped_picture_size() {
        // 1920×1080 的 High 档次 SPS（编码宽高是 1920×1088，裁掉下面 8 行）
        let sps = [
            0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78, 0x02, 0x27, 0xe5, 0xc0, 0x44, 0x00,
            0x00, 0x03, 0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0xf0, 0x3c, 0x60, 0xc6, 0x58,
        ];
        assert_eq!(sps_dimensions(&sps), Some((1920, 1080)));
    }

    /// 手动验证用：CKTV_REMUX_DIR 指向一个文件夹，里面按顺序是分片（*.ts，或 init.mp4 + *.m4s），
    /// 合成结果写到同一个文件夹的 out.mp4。用法：
    /// CKTV_REMUX_DIR=/path cargo test --lib remux::tests::remux_folder -- --ignored --nocapture
    #[test]
    #[ignore]
    fn remux_folder() {
        let dir = PathBuf::from(std::env::var("CKTV_REMUX_DIR").expect("设置 CKTV_REMUX_DIR"));
        let mut parts: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy().to_string();
                name.ends_with(".ts") || name.ends_with(".m4s") || name == "init.mp4"
            })
            .collect();
        parts.sort_by_key(|path| {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            (name != "init.mp4", name)
        });
        let out = dir.join("out.mp4");
        if parts.first().is_some_and(|path| path.ends_with("init.mp4")) {
            concat_fmp4(&parts, &out).unwrap();
            println!("fMP4 拼接完成");
        } else {
            match ts_to_mp4(&parts, &out) {
                Ok(stats) => println!("RESULT ok {stats:?}"),
                Err(err) => println!("RESULT err {err:?}"),
            }
        }
    }

    #[test]
    fn unsupported_codecs_are_named() {
        assert!(describe_stream(0x24).contains("H.265"));
        assert!(describe_stream(0x81).contains("AC-3"));
    }
}
