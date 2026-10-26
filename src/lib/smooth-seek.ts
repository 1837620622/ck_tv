// 拖动进度条只在松手时跳一次。
// ArtPlayer 拖动时每次鼠标或手指移动都会改一次播放位置。一次拖动就是几十次跳转，hls.js 每次都要
// 中断正在下载的片段、按新位置重新拉，拖完常常卡住，要再点一下播放才动。手机上点进度条也不会
// 跳到点的位置，拖动还是按起点相对移动的。
// 这里在播放器外层用捕获阶段先截住进度条上的拖动，画面上的横滑也由这里处理（播放器要设
// gesture: false 关掉 ArtPlayer 自带的那套）：拖动时只移动进度条、提示时间，松手时跳一次；
// 手机上点进度条直接跳到点的位置。单纯点击进度条仍交给 ArtPlayer（它本来就只跳一次）。

// 手指或鼠标移动超过这个距离才算拖动
const DRAG_THRESHOLD_PX = 4;
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

export function installSmoothSeek(art: Art): () => void {
  const player = art.template.$player;
  const progress = art.template.$progress;
  const video = art.template.$video;
  if (!player || !progress) return () => undefined;

  let drag: Drag | null = null;
  // 拖完松手后浏览器还会补一个 click，ArtPlayer 会按松手位置再跳一次，这里吞掉
  let swallowClickUntil = 0;

  const usable = () =>
    !art.option.isLive &&
    !art.isLock &&
    !art.isRotate &&
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
      if (current.moved) swallowClickUntil = Date.now() + 400;
      art.seek = current.target;
    }
  };

  // ---- 鼠标：只接管拖动，单击照旧 ----
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
        ratioAt(event.clientX, progress.getBoundingClientRect()) * art.duration,
    };
  };
  const onMouseMove = (event: MouseEvent) => {
    if (!drag || drag.kind !== 'progress') return;
    if (Math.abs(event.clientX - drag.startX) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    drag.target =
      ratioAt(event.clientX, progress.getBoundingClientRect()) * art.duration;
    show(drag.target);
  };
  const onMouseUp = () => {
    if (!drag || drag.kind !== 'progress') return;
    // 没拖动就是单击，交给 ArtPlayer 的 click
    if (!drag.moved) {
      drag = null;
      return;
    }
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
          ratioAt(touch.clientX, progress.getBoundingClientRect()) *
          art.duration,
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
    const dx = touch.clientX - drag.startX;
    const dy = touch.clientY - drag.startY;
    if (drag.kind === 'swipe' && !drag.decided) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        drag = null;
        return;
      }
      drag.decided = true;
    }
    // 进度条上的拖动要拦住 ArtPlayer 自己的逐帧跳转。画面上的横滑 ArtPlayer 不处理
    // （播放器关了它自带的 gesture），不拦，长按倍速照常能收到移动和松手。
    if (drag.kind === 'progress') event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    if (Math.abs(dx) > DRAG_THRESHOLD_PX) drag.moved = true;
    drag.target =
      drag.kind === 'progress'
        ? ratioAt(touch.clientX, progress.getBoundingClientRect()) *
          art.duration
        : swipeTarget(drag.startTime, dx, player.clientWidth, art.duration);
    show(drag.target);
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
  };
}
