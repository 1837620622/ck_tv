// Safari 的 AirPlay 选择器。Remote Playback（video.remote）不是 AirPlay，不能拿来代替。

type AirPlayVideo = HTMLVideoElement & {
  webkitShowPlaybackTargetPicker?: () => void;
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
