// 离开页面时停掉声音和画面。画中画先把节点留在页面外，退出后再停。

function isPictureInPicture(video: HTMLVideoElement): boolean {
  if (typeof document === 'undefined') return false;
  if (document.pictureInPictureElement === video) return true;
  const mode = (video as HTMLVideoElement & { webkitPresentationMode?: string })
    .webkitPresentationMode;
  return mode === 'picture-in-picture';
}

function stopElement(
  video: HTMLVideoElement | null | undefined,
  stop?: () => void
) {
  try {
    video?.pause();
  } catch {
    // 节点已经不在文档里时，暂停可能抛错。
  }
  try {
    stop?.();
  } catch {
    // 播放器销毁失败时继续清掉地址。
  }
  if (!video) return;
  try {
    video.removeAttribute('src');
    video.load();
  } catch {
    // 地址清不掉就停在暂停。
  }
}

export function releaseMedia(
  video: HTMLVideoElement | null | undefined,
  stop?: () => void
): void {
  if (video && isPictureInPicture(video)) {
    const holder = document.createElement('div');
    holder.dataset.ckPip = '1';
    holder.style.cssText =
      'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none';
    document.body.appendChild(holder);
    holder.appendChild(video);
    const leave = () => {
      video.removeEventListener('leavepictureinpicture', leave);
      video.removeEventListener('webkitpresentationmodechanged', onMode);
      stopElement(video, stop);
      holder.remove();
    };
    const onMode = () => {
      if (!isPictureInPicture(video)) leave();
    };
    video.addEventListener('leavepictureinpicture', leave);
    video.addEventListener('webkitpresentationmodechanged', onMode);
    return;
  }
  stopElement(video, stop);
}

export function silenceOtherMedia(
  current: HTMLMediaElement | null | undefined
) {
  if (typeof document === 'undefined') return;
  document.querySelectorAll('video, audio').forEach((node) => {
    const media = node as HTMLMediaElement;
    if (media === current) return;
    if (media instanceof HTMLVideoElement && isPictureInPicture(media)) return;
    media.pause();
  });
}
