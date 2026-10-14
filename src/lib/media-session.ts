// 系统媒体控制：锁屏界面、通知栏和耳机按键。浏览器不支持的部分直接跳过，不影响播放。
// 不设置的操作（比如没有上一集时的 previoustrack）要显式设成 null，否则锁屏上会留下点不动的按钮。

export interface MediaActionHandlers {
  play: () => void;
  pause: () => void;
  seekBackward: () => void;
  seekForward: () => void;
  previousTrack?: () => void;
  nextTrack?: () => void;
}

export interface MediaInfo {
  title: string;
  album?: string;
  artwork?: string;
}

interface MediaSessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(action: string, handler: (() => void) | null): void;
  setPositionState?(state: {
    duration: number;
    playbackRate: number;
    position: number;
  }): void;
}

type MediaMetadataCtor = new (init: {
  title: string;
  album?: string;
  artwork?: { src: string; sizes: string }[];
}) => unknown;

function mediaSession(): MediaSessionLike | null {
  if (typeof navigator === 'undefined') return null;
  return (
    (navigator as Navigator & { mediaSession?: MediaSessionLike })
      .mediaSession ?? null
  );
}

function metadataCtor(): MediaMetadataCtor | null {
  const ctor = (globalThis as { MediaMetadata?: MediaMetadataCtor })
    .MediaMetadata;
  return typeof ctor === 'function' ? ctor : null;
}

export function setMediaInfo(info: MediaInfo) {
  const session = mediaSession();
  const Ctor = metadataCtor();
  if (!session || !Ctor) return;
  try {
    session.metadata = new Ctor({
      title: info.title,
      album: info.album,
      // 系统会自己挑尺寸，给几种常见尺寸，缺哪个都会显示空白
      artwork: info.artwork
        ? ['96x96', '256x256', '512x512'].map((sizes) => ({
            src: info.artwork as string,
            sizes,
          }))
        : undefined,
    });
  } catch {
    // 个别浏览器对 artwork 地址挑剔，宁可没有封面也不能影响播放
  }
}

export function setMediaPlaybackState(state: 'playing' | 'paused' | 'none') {
  const session = mediaSession();
  if (session) session.playbackState = state;
}

// 进度条：时长未知或不合法时不报，否则浏览器会拒绝并抛错
export function setMediaPosition(input: {
  position: number;
  duration: number;
  playbackRate: number;
}) {
  const session = mediaSession();
  if (!session?.setPositionState) return;
  const { position, duration, playbackRate } = input;
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (!Number.isFinite(position) || position < 0 || position > duration) return;
  try {
    session.setPositionState({
      duration,
      playbackRate: playbackRate > 0 ? playbackRate : 1,
      position,
    });
  } catch {
    // 忽略：位置状态只影响锁屏进度条的显示
  }
}

// 绑定锁屏上的按钮，返回解绑函数
export function bindMediaActions(handlers: MediaActionHandlers): () => void {
  const session = mediaSession();
  if (!session) return () => undefined;
  const map: Record<string, (() => void) | undefined> = {
    play: handlers.play,
    pause: handlers.pause,
    seekbackward: handlers.seekBackward,
    seekforward: handlers.seekForward,
    previoustrack: handlers.previousTrack,
    nexttrack: handlers.nextTrack,
  };
  Object.entries(map).forEach(([action, handler]) => {
    try {
      session.setActionHandler(action, handler ?? null);
    } catch {
      // 浏览器不认识的操作名会抛错，跳过即可
    }
  });
  return () => {
    Object.keys(map).forEach((action) => {
      try {
        session.setActionHandler(action, null);
      } catch {
        // 同上
      }
    });
  };
}
