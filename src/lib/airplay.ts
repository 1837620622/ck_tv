// Safari 的 AirPlay。Remote Playback（video.remote）不是 AirPlay，不能拿来代替。
// AirPlay 要求 video 的播放地址唯一且是原生可播的 HLS；hls.js 的 MSE（blob）地址投不出去，
// 所以投屏前要先切到原始 m3u8 的原生播放，见 loadNativeSource。

type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

export type AirPlayResult = 'shown' | 'unsupported' | 'no-video';

export function airPlayPicker(video: HTMLVideoElement | null): AirPlayResult {
  if (!video) return 'no-video';
  const picker = (video as AirPlayVideo).webkitShowPlaybackTargetPicker;
  if (typeof picker !== 'function') return 'unsupported';
  try {
    picker.call(video);
    return 'shown';
  } catch {
    return 'unsupported';
  }
}

// 正在投到 AirPlay 设备上播放。此时不能把 video 的地址换回去，否则会断开投屏。
export function isAirPlaying(video: HTMLVideoElement): boolean {
  return (video as AirPlayVideo).webkitCurrentPlaybackTargetIsWireless === true;
}

export function supportsNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

// 把 video 切到原生播放的 url，并回到调用方记下的进度与播放状态。
// 进度要由调用方在销毁 hls.js 之前读取：销毁时浏览器会清空 currentTime 和 paused。
// 成功 resolve true；超时或出错 resolve false，调用方可以放弃 AirPlay。
export function loadNativeSource(
  video: HTMLVideoElement,
  url: string,
  options: { at: number; resume: boolean; timeoutMs?: number }
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      if (Number.isFinite(options.at) && options.at > 0) {
        video.currentTime = options.at;
      }
      if (options.resume) void video.play().catch(() => undefined);
      resolve(true);
    };
    const onError = () => {
      cleanup();
      resolve(false);
    };
    timer = window.setTimeout(() => {
      cleanup();
      resolve(false);
    }, options.timeoutMs ?? 8000);
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
    video.src = url;
    video.load();
  });
}

// 订阅 AirPlay 设备是否可用。只有原生 HLS 的 video 才会触发这个事件。返回取消订阅的函数。
export function watchAirPlayTargets(
  video: HTMLVideoElement,
  onChange: (available: boolean) => void
): () => void {
  const handler = (event: Event) => {
    const availability = (event as Event & { availability?: string })
      .availability;
    onChange(availability === 'available');
  };
  video.addEventListener('webkitplaybacktargetavailabilitychanged', handler);
  return () =>
    video.removeEventListener(
      'webkitplaybacktargetavailabilitychanged',
      handler
    );
}
