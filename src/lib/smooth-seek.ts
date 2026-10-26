// 拖动进度条只在松手时跳一次。
// ArtPlayer 拖动时每次鼠标或手指移动都会改一次播放位置。一次拖动就是几十次跳转，hls.js 每次都要
// 中断正在下载的片段、按新位置重新拉，拖完常常卡住，要再点一下播放才动。手机上点进度条也不会
// 跳到点的位置，拖动还是按起点相对移动的。
// 这里在播放器外层用捕获阶段先截住进度条上的点击和拖动，画面上的横滑也由这里处理（播放器要设
// gesture: false 关掉 ArtPlayer 自带的那套）：
// - 点进度条任何位置（包括圆点上）都跳到那里。ArtPlayer 点在圆点上不跳。
// - 拖动时先暂停，画面跟着拖到的位置预览：同一时间只有一次跳转在进行，上一次画面出来后
//   再跳下一次，最快每 0.2 秒一次；松手时跳到准确位置，原来在播就接着播。
// - 网页全屏时 ArtPlayer 会把播放器转 90 度，进度条和横滑都要按转后的方向换算，
//   见 progressRatio 和 playerDelta。

// 手指或鼠标移动超过这个距离才算拖动
const DRAG_THRESHOLD_PX = 4;
// 拖动预览两次跳转之间至少隔这么久
const PREVIEW_INTERVAL_MS = 200;
// 预览跳转迟迟等不到 seeked（例如片段一直下不来），过了这个时间就放行下一次
const PREVIEW_STUCK_MS = 1500;
// 在画面上横向滑动调进度：滑过整个画面宽度对应的片长比例，和 ArtPlayer 的 TOUCH_MOVE_RATIO 一致
const SWIPE_RATIO = 0.5;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// 进度条上某个横坐标对应的比例
export function ratioAt(
  clientX: number,
  rect: { left: number; width: number }
) {
  if (!rect.width) return 0;
  return clamp01((clientX - rect.left) / rect.width);
}

// 进度条上某个点对应的比例。播放器转了 90 度（网页全屏、竖屏手机看横屏视频）时进度条是竖着的，
// 按纵坐标算，顶端为 0，和 ArtPlayer 自己的换算一致。
export function progressRatio(
  rotated: boolean,
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number }
): number {
  return rotated
    ? ratioAt(y, { left: rect.top, width: rect.height })
    : ratioAt(x, { left: rect.left, width: rect.width });
}

// 屏幕上的一次移动换成播放器自己坐标里的移动。播放器顺时针转 90 度后，屏幕的下方是播放器的右边。
export function playerDelta(
  rotated: boolean,
  dx: number,
  dy: number
): { x: number; y: number } {
  return rotated ? { x: dy, y: -dx } : { x: dx, y: dy };
}

// 在画面上从 startTime 开始横向滑了 dx 像素，对应的目标时间
export function swipeTarget(
  startTime: number,
  dx: number,
  width: number,
  duration: number
): number {
  if (!width || !Number.isFinite(duration) || duration <= 0) return startTime;
  const delta = (dx / width) * duration * SWIPE_RATIO;
  return Math.min(duration, Math.max(0, startTime + delta));
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

type Art = {
  template: {
    $player: HTMLElement;
    $progress?: HTMLElement;
    $video?: HTMLElement;
  };
  duration: number;
  currentTime: number;
  seek: number;
  isLock?: boolean;
  isRotate?: boolean;
  option: { isLive?: boolean };
  notice: { show: string };
  emit: (name: string, ...args: unknown[]) => void;
  on: (name: string, fn: () => void) => void;
};

type Drag = {
  kind: 'progress' | 'swipe';
  startX: number;
  startY: number;
  startTime: number;
  moved: boolean;
  // 画面滑动先要确认是横向；竖向滑动交还给页面滚动
  decided: boolean;
  target: number;
};

type Options = {
  // 拖动预览开始和结束时通知页面。预览跳转不走 art.seek，页面据此暂停跳片头片尾、记进度等逻辑。
  onScrub?: (active: boolean) => void;
};

export function installSmoothSeek(art: Art, options: Options = {}): () => void {
  const player = art.template.$player;
  const progress = art.template.$progress;
  const video = art.template.$video;
  if (!player || !progress) return () => undefined;

  let drag: Drag | null = null;
  // 点击和拖动都由这里跳转，浏览器随后补的 click 不再交给 ArtPlayer，免得再跳一次
  let swallowClickUntil = 0;

  // ---- 拖动预览：暂停后让画面跟着拖到的位置走 ----
  const media = (video as HTMLVideoElement | undefined) || null;
  let scrubbing = false;
  let resumeAfterScrub = false;
  let previewBusy = false;
  let previewBusySince = 0;
  let previewWanted: number | null = null;
  let previewAt = 0;
  let previewTimer = 0;

  const pumpPreview = () => {
    if (!media || previewWanted === null) return;
    const now = Date.now();
    if (previewBusy && now - previewBusySince < PREVIEW_STUCK_MS) return;
    const wait = PREVIEW_INTERVAL_MS - (now - previewAt);
    if (wait > 0) {
      if (!previewTimer) {
        previewTimer = window.setTimeout(() => {
          previewTimer = 0;
          pumpPreview();
        }, wait);
      }
      return;
    }
    const time = previewWanted;
    previewWanted = null;
    previewBusy = true;
    previewBusySince = now;
    previewAt = now;
    try {
      media.currentTime = time;
    } catch {
      previewBusy = false;
    }
  };
  const onSeeked = () => {
    previewBusy = false;
    if (scrubbing) pumpPreview();
  };
  media?.addEventListener('seeked', onSeeked);

  const startScrub = () => {
    if (scrubbing || !media) return;
    scrubbing = true;
    options.onScrub?.(true);
    resumeAfterScrub = !media.paused;
    if (resumeAfterScrub) media.pause();
  };
  const preview = (time: number) => {
    startScrub();
    // 预览不落到片尾最后一刻，免得触发播放结束、自动连播
    previewWanted = Math.max(0, Math.min(time, art.duration - 1));
    pumpPreview();
  };
  const endScrub = () => {
    previewWanted = null;
    if (previewTimer) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    if (!scrubbing) return;
    scrubbing = false;
    options.onScrub?.(false);
    if (resumeAfterScrub && media) {
      resumeAfterScrub = false;
      const playing = media.play();
      if (playing && typeof playing.catch === 'function') {
        playing.catch(() => undefined);
      }
    }
  };

  const rotated = () => Boolean(art.isRotate);
  const usable = () =>
    !art.option.isLive &&
    !art.isLock &&
    Number.isFinite(art.duration) &&
    art.duration > 0;

  const show = (time: number) => {
    art.emit('setBar', 'played', clamp01(time / art.duration));
    art.notice.show = `${formatClock(time)} / ${formatClock(art.duration)}`;
  };

  const finish = () => {
    const current = drag;
    drag = null;
    if (!current) return;
    if (current.kind === 'progress' || current.moved) {
      swallowClickUntil = Date.now() + 400;
      art.seek = current.target;
    }
    endScrub();
  };

  // ---- 鼠标：点哪跳哪，拖动时预览，松手跳一次 ----
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || !usable()) return;
    if (!progress.contains(event.target as Node)) return;
    // 不让 ArtPlayer 进入它自己的拖动状态
    event.stopPropagation();
    drag = {
      kind: 'progress',
      startX: event.clientX,
      startY: event.clientY,
      startTime: art.currentTime,
      moved: false,
      decided: true,
      target:
        progressRatio(
          rotated(),
          event.clientX,
          event.clientY,
          progress.getBoundingClientRect()
        ) * art.duration,
    };
  };
  const onMouseMove = (event: MouseEvent) => {
    if (!drag || drag.kind !== 'progress') return;
    const along = playerDelta(
      rotated(),
      event.clientX - drag.startX,
      event.clientY - drag.startY
    ).x;
    if (Math.abs(along) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    drag.target =
      progressRatio(
        rotated(),
        event.clientX,
        event.clientY,
        progress.getBoundingClientRect()
      ) * art.duration;
    show(drag.target);
    preview(drag.target);
  };
  const onMouseUp = () => {
    if (!drag || drag.kind !== 'progress') return;
    // 没拖动就是单击：跳到按下的位置
    finish();
  };
  const onClick = (event: MouseEvent) => {
    if (
      Date.now() < swallowClickUntil &&
      progress.contains(event.target as Node)
    ) {
      event.stopPropagation();
    }
  };

  // ---- 触摸：进度条上点哪跳哪、拖到哪跳到哪；画面上横滑按比例调 ----
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1 || !usable()) {
      drag = null;
      return;
    }
    const touch = event.touches[0];
    const target = event.target as Node;
    if (progress.contains(target)) {
      drag = {
        kind: 'progress',
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: art.currentTime,
        moved: false,
        decided: true,
        target:
          progressRatio(
            rotated(),
            touch.clientX,
            touch.clientY,
            progress.getBoundingClientRect()
          ) * art.duration,
      };
      show(drag.target);
      event.stopPropagation();
    } else if (video && video.contains(target)) {
      drag = {
        kind: 'swipe',
        startX: touch.clientX,
        startY: touch.clientY,
        startTime: art.currentTime,
        moved: false,
        decided: false,
        target: art.currentTime,
      };
    }
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!drag || event.touches.length !== 1) return;
    const touch = event.touches[0];
    // 换成播放器自己的方向：x 是沿进度条（或画面横向）的移动，y 是垂直于它的移动
    const { x: px, y: py } = playerDelta(
      rotated(),
      touch.clientX - drag.startX,
      touch.clientY - drag.startY
    );
    if (drag.kind === 'swipe' && !drag.decided) {
      if (Math.abs(px) < 10 && Math.abs(py) < 10) return;
      if (Math.abs(py) > Math.abs(px)) {
        drag = null;
        return;
      }
      drag.decided = true;
    }
    // 进度条上的拖动要拦住 ArtPlayer 自己的逐帧跳转。画面上的横滑 ArtPlayer 不处理
    // （播放器关了它自带的 gesture），不拦，长按倍速照常能收到移动和松手。
    if (drag.kind === 'progress') event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    if (Math.abs(px) > DRAG_THRESHOLD_PX) drag.moved = true;
    drag.target =
      drag.kind === 'progress'
        ? progressRatio(
            rotated(),
            touch.clientX,
            touch.clientY,
            progress.getBoundingClientRect()
          ) * art.duration
        : swipeTarget(drag.startTime, px, player.clientWidth, art.duration);
    show(drag.target);
    if (drag.moved) preview(drag.target);
  };
  const onTouchEnd = () => {
    if (!drag) return;
    if (drag.kind === 'swipe' && !drag.moved) {
      drag = null;
      return;
    }
    finish();
  };

  // 拖动中播放器自己还会按真实进度刷新进度条，盖回拖动的位置
  const keepBar = () => {
    if (drag && (drag.kind === 'progress' || drag.moved)) {
      art.emit('setBar', 'played', clamp01(drag.target / art.duration));
    }
  };

  player.addEventListener('mousedown', onMouseDown, true);
  player.addEventListener('click', onClick, true);
  player.addEventListener('touchstart', onTouchStart, {
    capture: true,
    passive: true,
  });
  player.addEventListener('touchmove', onTouchMove, {
    capture: true,
    passive: false,
  });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('touchend', onTouchEnd);
  document.addEventListener('touchcancel', onTouchEnd);
  art.on('video:timeupdate', keepBar);

  return () => {
    player.removeEventListener('mousedown', onMouseDown, true);
    player.removeEventListener('click', onClick, true);
    player.removeEventListener('touchstart', onTouchStart, true);
    player.removeEventListener('touchmove', onTouchMove, true);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('touchend', onTouchEnd);
    document.removeEventListener('touchcancel', onTouchEnd);
    media?.removeEventListener('seeked', onSeeked);
    if (previewTimer) window.clearTimeout(previewTimer);
    if (scrubbing) options.onScrub?.(false);
  };
}
