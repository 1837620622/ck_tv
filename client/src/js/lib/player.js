// CKTV 播放器用的纯函数：时间格式、手势判断、拖动换算、续播位置。不碰 DOM，方便测试。

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** 长按时的倍速 */
export const HOLD_SPEED = 2;
/** 手指移动超过这么多像素才算拖动，不算点击 */
export const DRAG_THRESHOLD = 12;
/** 横向划满整个画面宽度最多跳这么多秒（短视频按时长缩小） */
export const SEEK_SPAN_SECONDS = 180;
/** 续播：看过不到这么久、或离结尾不到这么久，就从头 / 不续播 */
const RESUME_MIN_SECONDS = 10;
const RESUME_TAIL_SECONDS = 15;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 秒数 → 03:07 或 1:02:07；不是有效数字时显示 00:00 */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 带正负号的秒数差：+15 秒、-1:05 */
export function formatDelta(seconds) {
  const sign = seconds < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(seconds));
  return abs < 60 ? `${sign}${abs} 秒` : `${sign}${formatTime(abs)}`;
}

/**
 * 手指移动后判断手势：没超过阈值是 'none'（可能还是点击或长按），
 * 横向为主是 'seek'（调进度），纵向为主是 'vertical'（左半边亮度、右半边音量）。
 */
export function classifyGesture(dx, dy, threshold = DRAG_THRESHOLD) {
  if (Math.hypot(dx, dy) < threshold) return 'none';
  return Math.abs(dx) >= Math.abs(dy) ? 'seek' : 'vertical';
}

/** 横向拖动换算成目标时间：划满宽度跳 min(时长, 180) 秒 */
export function seekTarget(start, dx, width, duration) {
  if (!Number.isFinite(duration) || duration <= 0 || width <= 0) return start;
  const span = Math.min(duration, SEEK_SPAN_SECONDS);
  return clamp(start + (dx / width) * span, 0, duration);
}

/** 纵向拖动换算成 0–1 的值：向上划变大，划过画面高度从 0 到 1 */
export function verticalLevel(start, dy, height) {
  if (height <= 0) return start;
  return clamp(start - dy / height, 0, 1);
}

/** 亮度 0–1 → 遮罩不透明度：最暗时盖 0.75 的黑色，最亮时不盖 */
export function dimOpacity(brightness) {
  return Number((0.75 * (1 - clamp(brightness, 0, 1))).toFixed(3));
}

/** 进度条上点击位置 → 时间 */
export function timeAtRatio(ratio, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return clamp(ratio, 0, 1) * duration;
}

/** 上次看到的位置值不值得续播：太靠前或已经快看完都不续 */
export function resumePoint(saved, duration) {
  if (!Number.isFinite(saved) || !Number.isFinite(duration)) return 0;
  if (saved < RESUME_MIN_SECONDS || saved > duration - RESUME_TAIL_SECONDS) {
    return 0;
  }
  return saved;
}

/** 每个视频单独记进度。地址可能很长，用一个短的哈希做键。 */
export function progressKey(source) {
  let hash = 2166136261;
  for (const char of String(source)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `cktv-player-pos:${hash.toString(36)}`;
}

/** 下一个倍速（倍速按钮循环切换） */
export function nextSpeed(current) {
  const index = SPEEDS.indexOf(current);
  return SPEEDS[(index + 1) % SPEEDS.length] ?? 1;
}

export function speedLabel(rate) {
  return rate === 1 ? '倍速' : `${rate}X`;
}

/**
 * 播放器地址的参数：
 *   src    在线视频地址（http/https，m3u8 或 mp4）
 *   file   本机文件路径（下载好的视频）；kind=hls 表示分片文件夹里的 index.m3u8
 *   title  标题
 *   back   返回到哪里（站点页面地址或 downloads.html）
 */
export function readParams(search) {
  const params = new URLSearchParams(search);
  const src = params.get('src') || '';
  const file = params.get('file') || '';
  const online = /^https?:\/\//i.test(src);
  return {
    src: online ? src : '',
    file: online ? '' : file,
    kind: params.get('kind') === 'hls' ? 'hls' : 'file',
    title: (params.get('title') || '').trim().slice(0, 120),
    back: safeBack(params.get('back') || ''),
  };
}

/** 应用自己的页面，可以作为「返回」的目标 */
const LOCAL_PAGES = ['index.html', 'downloads.html', 'updates.html'];

/**
 * 「返回」去哪里。播放器是本地页面，任何页面都可能带着参数打开它，所以这里不信任参数：
 * 只接受 http(s) 地址和应用自己的几个页面，javascript: 之类的一律不要。
 */
export function safeBack(raw) {
  const value = String(raw).trim();
  if (LOCAL_PAGES.includes(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : '';
  } catch {
    return '';
  }
}

/** 是不是分片视频地址（决定用 hls.js 还是直接交给 video） */
export function isPlaylist(source) {
  try {
    return /\.m3u8$/i.test(new URL(source).pathname);
  } catch {
    return /\.m3u8(\?|#|$)/i.test(String(source));
  }
}

/** 视频来源的简短说明：域名或「本机视频」 */
export function sourceLabel({ src, file }) {
  if (file) return '本机视频（已下载）';
  try {
    return new URL(src).hostname;
  } catch {
    return '';
  }
}
