// 播放器进度条上的白色缓冲条，以及「已缓冲 N 秒」。
// ArtPlayer 自带的那条只按最后一段缓冲画、颜色是 25% 的白，而且只在 progress 事件里更新；
// hls.js 往 MSE 里追加数据时浏览器不一定发 progress，拖动进度后它也画错。这里按全部已缓冲区间画，
// 播放中每半秒刷新一次。

export type BufferRange = [number, number];

export type BufferSegment = {
  left: number; // 百分比
  width: number; // 百分比
};

// 两段之间的空隙小于这个秒数就画成一段，避免进度条上碎成很多细条
const MERGE_GAP_SECONDS = 0.5;
// 当前位置落在某段缓冲里的容差：hls.js 片段之间常有零点几秒的缝
const AHEAD_TOLERANCE_SECONDS = 0.3;

export function readRanges(
  buffered: TimeRanges | null | undefined
): BufferRange[] {
  const ranges: BufferRange[] = [];
  if (!buffered) return ranges;
  for (let i = 0; i < buffered.length; i += 1) {
    try {
      const start = buffered.start(i);
      const end = buffered.end(i);
      if (end > start) ranges.push([start, end]);
    } catch {
      // 区间在读取时被清掉了，跳过
    }
  }
  return ranges;
}

function mergeRanges(ranges: BufferRange[], gap: number): BufferRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: BufferRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start - last[1] <= gap) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

export function bufferSegments(
  ranges: BufferRange[],
  duration: number
): BufferSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  return mergeRanges(ranges, MERGE_GAP_SECONDS)
    .map(([start, end]) => {
      const left = Math.max(0, Math.min(100, (start / duration) * 100));
      const right = Math.max(0, Math.min(100, (end / duration) * 100));
      return { left, width: right - left };
    })
    .filter((segment) => segment.width > 0.05);
}

// 从当前位置往后已经缓冲了多少秒。当前位置不在任何缓冲里时是 0。
export function bufferedAhead(ranges: BufferRange[], current: number): number {
  for (const [start, end] of mergeRanges(ranges, MERGE_GAP_SECONDS)) {
    if (
      current >= start - AHEAD_TOLERANCE_SECONDS &&
      current <= end + AHEAD_TOLERANCE_SECONDS
    ) {
      return Math.max(0, end - current);
    }
  }
  return 0;
}

export function formatAhead(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 1) return '缓冲中';
  const whole = Math.floor(seconds);
  if (whole < 60) return `已缓冲 ${whole} 秒`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0
    ? `已缓冲 ${minutes} 分`
    : `已缓冲 ${minutes} 分 ${rest} 秒`;
}

type PlayerLike = {
  template?: { $player?: HTMLElement };
  video?: HTMLVideoElement;
  on?: (name: string, fn: () => void) => void;
};

// 挂到 ArtPlayer 上。返回拆除函数。找不到进度条（例如播放器被换掉）时什么都不做。
export function attachBufferBar(art: PlayerLike): () => void {
  const player = art.template?.$player;
  const video = art.video;
  const loaded = player?.querySelector('.art-progress-loaded');
  const track = loaded?.parentElement;
  if (!player || !video || !track) return () => undefined;

  track.querySelector('.ck-buffer')?.remove();
  const layer = document.createElement('div');
  layer.className = 'ck-buffer';
  track.appendChild(layer);

  let frame = 0;
  const paint = () => {
    frame = 0;
    const ranges = readRanges(video.buffered);
    const segments = bufferSegments(ranges, video.duration);
    while (layer.children.length < segments.length) {
      layer.appendChild(document.createElement('i'));
    }
    while (layer.children.length > segments.length) {
      layer.lastChild?.remove();
    }
    segments.forEach((segment, index) => {
      const el = layer.children[index] as HTMLElement;
      el.style.left = `${segment.left}%`;
      el.style.width = `${segment.width}%`;
    });
    const label = player.querySelector('.ck-buffered');
    if (label) {
      const text = formatAhead(bufferedAhead(ranges, video.currentTime));
      if (label.textContent !== text) label.textContent = text;
    }
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(paint);
  };

  const events = [
    'progress',
    'loadedmetadata',
    'durationchange',
    'seeked',
    'emptied',
    'waiting',
    'playing',
  ];
  events.forEach((name) => video.addEventListener(name, schedule));
  // MSE 追加数据时不一定发 progress，定时补一次
  const timer = window.setInterval(schedule, 500);
  schedule();

  return () => {
    events.forEach((name) => video.removeEventListener(name, schedule));
    window.clearInterval(timer);
    if (frame) window.cancelAnimationFrame(frame);
    layer.remove();
  };
}
