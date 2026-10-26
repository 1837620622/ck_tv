import {
  clamp01,
  formatClock,
  installSmoothSeek,
  playerDelta,
  progressRatio,
  ratioAt,
  swipeTarget,
} from './smooth-seek';

// rotated 为真时模拟网页全屏转了 90 度：进度条竖着放，纵坐标 100 到 500 对应整条进度条
function fakePlayer(duration = 600, { playing = true, rotated = false } = {}) {
  const player = document.createElement('div');
  const progress = document.createElement('div');
  const inner = document.createElement('div');
  const video = document.createElement('video');
  progress.appendChild(inner);
  player.append(video, progress);
  document.body.appendChild(player);
  progress.getBoundingClientRect = () =>
    (rotated
      ? { left: 0, top: 100, width: 6, height: 400 }
      : { left: 100, top: 0, width: 400, height: 6 }) as DOMRect;
  Object.defineProperty(player, 'clientWidth', { value: 800 });
  // 预览直接改 video.currentTime，这里记下每次改动
  const previews: number[] = [];
  const media = { paused: !playing, plays: 0, pauses: 0 };
  Object.defineProperty(video, 'currentTime', {
    get: () => previews[previews.length - 1] ?? 0,
    set: (value: number) => {
      previews.push(value);
    },
  });
  Object.defineProperty(video, 'paused', { get: () => media.paused });
  video.pause = () => {
    media.paused = true;
    media.pauses += 1;
  };
  video.play = () => {
    media.paused = false;
    media.plays += 1;
    return Promise.resolve();
  };
  const seeks: number[] = [];
  const bars: number[] = [];
  const handlers: Record<string, Array<() => void>> = {};
  const art = {
    template: { $player: player, $progress: progress, $video: video },
    duration,
    currentTime: 60,
    set seek(value: number) {
      seeks.push(value);
    },
    get seek() {
      return 0;
    },
    isLock: false,
    isRotate: rotated,
    option: { isLive: false },
    notice: { show: '' },
    emit: (name: string, ...args: unknown[]) => {
      const [kind, value] = args as [string, number];
      if (name === 'setBar' && kind === 'played') bars.push(value);
    },
    on: (name: string, fn: () => void) => {
      (handlers[name] ||= []).push(fn);
    },
  };
  const scrubs: boolean[] = [];
  const detach = installSmoothSeek(art, {
    onScrub: (active) => scrubs.push(active),
  });
  return {
    art,
    player,
    progress,
    inner,
    video,
    media,
    previews,
    scrubs,
    seeks,
    bars,
    handlers,
    detach,
  };
}

// 按下和移动时主键是按着的（buttons 为 1），松开时为 0，和真实鼠标事件一致
function mouse(
  type: string,
  target: EventTarget,
  clientX: number,
  clientY = 0
) {
  const buttons = type === 'mouseup' || type === 'click' ? 0 : 1;
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      button: 0,
      buttons,
      clientX,
      clientY,
    })
  );
}

function touch(
  type: string,
  target: EventTarget,
  clientX: number,
  clientY = 0
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = [{ clientX, clientY }];
  Object.defineProperty(event, 'touches', {
    value: type === 'touchend' ? [] : point,
  });
  target.dispatchEvent(event);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('helpers', () => {
  it('maps a pointer position on the bar to a ratio', () => {
    expect(ratioAt(300, { left: 100, width: 400 })).toBe(0.5);
    expect(ratioAt(50, { left: 100, width: 400 })).toBe(0);
    expect(ratioAt(900, { left: 100, width: 400 })).toBe(1);
    expect(ratioAt(300, { left: 100, width: 0 })).toBe(0);
    expect(clamp01(NaN)).toBe(0);
  });

  it('turns a swipe on the picture into a time, at half speed like ArtPlayer', () => {
    expect(swipeTarget(100, 400, 800, 600)).toBe(250);
    expect(swipeTarget(100, -800, 800, 600)).toBe(0);
    expect(swipeTarget(590, 800, 800, 600)).toBe(600);
    expect(swipeTarget(100, 400, 800, Infinity)).toBe(100);
  });

  it('formats times', () => {
    expect(formatClock(65)).toBe('01:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(-3)).toBe('00:00');
  });
});

describe('dragging the progress bar with a mouse', () => {
  it('seeks once when the button is released, not on every move', () => {
    const { inner, seeks, bars } = fakePlayer();
    mouse('mousedown', inner, 150);
    for (let x = 160; x <= 400; x += 20) mouse('mousemove', document, x);
    mouse('mouseup', document, 400);
    expect(seeks).toEqual([450]);
    // 拖动过程中进度条一直跟着走
    expect(bars.length).toBeGreaterThan(5);
    expect(bars[bars.length - 1]).toBeCloseTo(0.75);
  });

  it('jumps to the clicked spot, and ArtPlayer does not seek again', () => {
    const { progress, inner, seeks, previews, media } = fakePlayer();
    const artplayerClick = jest.fn();
    progress.addEventListener('click', artplayerClick);
    mouse('mousedown', inner, 300);
    mouse('mouseup', document, 300);
    mouse('click', inner, 300);
    expect(seeks).toEqual([300]);
    expect(artplayerClick).not.toHaveBeenCalled();
    // 单击不预览，也不暂停
    expect(previews).toEqual([]);
    expect(media.pauses).toBe(0);
  });

  it('keeps ArtPlayer from starting its own drag', () => {
    const { progress, inner } = fakePlayer();
    const artplayerDown = jest.fn();
    progress.addEventListener('mousedown', artplayerDown);
    mouse('mousedown', inner, 300);
    expect(artplayerDown).not.toHaveBeenCalled();
  });

  it('swallows the click that follows a drag so ArtPlayer does not seek again', () => {
    const { progress, inner } = fakePlayer();
    const artplayerClick = jest.fn();
    progress.addEventListener('click', artplayerClick);
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 350);
    mouse('mouseup', document, 350);
    mouse('click', inner, 350);
    expect(artplayerClick).not.toHaveBeenCalled();
    // 下一次普通点击照常
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    mouse('click', inner, 350);
    expect(artplayerClick).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  it('keeps the bar at the dragged spot while the video keeps reporting time', () => {
    const { inner, bars, handlers } = fakePlayer();
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 300);
    handlers['video:timeupdate'].forEach((fn) => fn());
    expect(bars[bars.length - 1]).toBeCloseTo(0.5);
  });

  it('does nothing for live streams or a locked player', () => {
    const live = fakePlayer();
    live.art.option.isLive = true;
    mouse('mousedown', live.inner, 150);
    mouse('mousemove', document, 350);
    mouse('mouseup', document, 350);
    expect(live.seeks).toEqual([]);
  });
});

describe('touch', () => {
  it('jumps to the tapped spot on the bar', () => {
    const { inner, seeks } = fakePlayer();
    touch('touchstart', inner, 200);
    touch('touchend', document, 200);
    expect(seeks).toEqual([150]);
  });

  it('follows the finger along the bar and seeks once at the end', () => {
    const { inner, seeks } = fakePlayer();
    touch('touchstart', inner, 120);
    for (let x = 140; x <= 460; x += 40) touch('touchmove', inner, x);
    touch('touchend', document, 460);
    expect(seeks).toEqual([540]);
  });

  it('seeks once after a horizontal swipe on the picture', () => {
    const { video, seeks } = fakePlayer();
    touch('touchstart', video, 100, 100);
    for (let x = 120; x <= 500; x += 40) touch('touchmove', video, x, 104);
    touch('touchend', document, 500, 104);
    // 起点 60 秒，滑了 380 像素 / 800 宽 × 600 秒 × 0.5
    expect(seeks).toEqual([60 + (380 / 800) * 600 * 0.5]);
  });

  it('ignores vertical swipes and plain taps on the picture', () => {
    const { video, seeks } = fakePlayer();
    touch('touchstart', video, 100, 100);
    touch('touchmove', video, 104, 160);
    touch('touchmove', video, 106, 260);
    touch('touchend', document, 106, 260);
    touch('touchstart', video, 100, 100);
    touch('touchend', document, 100, 100);
    expect(seeks).toEqual([]);
  });
});

describe('previewing the picture while dragging', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('pauses, shows the dragged spot, and resumes after the release', () => {
    const { inner, video, media, previews, scrubs, seeks } = fakePlayer();
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 300);
    expect(media.paused).toBe(true);
    expect(previews).toEqual([300]);
    expect(scrubs).toEqual([true]);
    mouse('mouseup', document, 300);
    expect(seeks).toEqual([300]);
    expect(media.plays).toBe(1);
    expect(scrubs).toEqual([true, false]);
    // 预览跳转完成后的 seeked 不会再跳
    video.dispatchEvent(new Event('seeked'));
    expect(previews).toEqual([300]);
  });

  it('runs one preview seek at a time and jumps to the latest spot next', () => {
    const { inner, video, previews } = fakePlayer();
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 200);
    mouse('mousemove', document, 250);
    mouse('mousemove', document, 300);
    expect(previews).toEqual([150]);
    // 上一次画面出来了，但离上次跳转不到 0.2 秒，要等到点
    video.dispatchEvent(new Event('seeked'));
    expect(previews).toEqual([150]);
    jest.advanceTimersByTime(200);
    expect(previews).toEqual([150, 300]);
  });

  it('moves on when a preview seek never finishes', () => {
    const { inner, previews } = fakePlayer();
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 200);
    now.mockReturnValue(start + 400);
    mouse('mousemove', document, 300);
    expect(previews).toEqual([150]);
    now.mockReturnValue(start + 1600);
    mouse('mousemove', document, 350);
    expect(previews).toEqual([150, 375]);
    now.mockRestore();
  });

  it('stays paused after the release when it was paused before', () => {
    const { inner, media, seeks } = fakePlayer(600, { playing: false });
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 300);
    mouse('mouseup', document, 300);
    expect(seeks).toEqual([300]);
    expect(media.plays).toBe(0);
    expect(media.paused).toBe(true);
  });

  it('keeps the preview off the last second so it does not end the episode', () => {
    const { inner, previews, seeks } = fakePlayer();
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 600);
    expect(previews).toEqual([599]);
    mouse('mouseup', document, 600);
    expect(seeks).toEqual([600]);
  });

  it('previews while a finger drags along the bar', () => {
    const { inner, media, previews, seeks } = fakePlayer();
    touch('touchstart', inner, 120);
    touch('touchmove', inner, 300);
    expect(media.paused).toBe(true);
    expect(previews).toEqual([300]);
    touch('touchend', document, 300);
    expect(seeks).toEqual([300]);
    expect(media.plays).toBe(1);
  });
});

describe('rotated player (web fullscreen turned 90 degrees)', () => {
  it('maps a point on the vertical bar by its height, top is 0', () => {
    const rect = { left: 0, top: 100, width: 6, height: 400 };
    expect(progressRatio(true, 3, 300, rect)).toBe(0.5);
    expect(progressRatio(true, 3, 50, rect)).toBe(0);
    expect(
      progressRatio(false, 300, 3, { left: 100, top: 0, width: 400, height: 6 })
    ).toBe(0.5);
  });

  it('turns screen movement into the player direction', () => {
    expect(playerDelta(false, 10, 20)).toEqual({ x: 10, y: 20 });
    // 顺时针转 90 度：屏幕向下是播放器向右
    expect(playerDelta(true, 10, 20)).toEqual({ x: 20, y: -10 });
  });

  it('seeks where a tap lands on the vertical bar', () => {
    const { inner, seeks } = fakePlayer(600, { rotated: true });
    mouse('mousedown', inner, 3, 300);
    mouse('mouseup', document, 3, 300);
    expect(seeks).toEqual([300]);
  });

  it('previews and seeks once when the mouse drags along the vertical bar', () => {
    const { inner, seeks, previews, media } = fakePlayer(600, {
      rotated: true,
    });
    mouse('mousedown', inner, 3, 140);
    mouse('mousemove', document, 3, 340);
    // 纵坐标 340 在 100 到 500 的竖条上是 0.6
    expect(media.paused).toBe(true);
    expect(previews[previews.length - 1]).toBe(360);
    mouse('mouseup', document, 3, 340);
    expect(seeks).toEqual([360]);
    expect(media.plays).toBe(1);
  });

  it('follows a finger down the vertical bar', () => {
    const { inner, seeks } = fakePlayer(600, { rotated: true });
    touch('touchstart', inner, 3, 120);
    for (let y = 140; y <= 460; y += 40) touch('touchmove', inner, 3, y);
    touch('touchend', document, 3, 460);
    expect(seeks).toEqual([540]);
  });

  it('swipes the picture forward when the finger moves down the screen', () => {
    const { video, seeks } = fakePlayer(600, { rotated: true });
    touch('touchstart', video, 100, 100);
    for (let y = 140; y <= 460; y += 40) touch('touchmove', video, 104, y);
    touch('touchmove', video, 104, 480);
    touch('touchend', document, 104, 480);
    // 屏幕向下 380 像素，播放器横向 380 像素，起点 60 秒
    expect(seeks).toEqual([60 + (380 / 800) * 600 * 0.5]);
  });

  it('ignores a sideways swipe on the screen when the player is turned', () => {
    const { video, seeks } = fakePlayer(600, { rotated: true });
    touch('touchstart', video, 100, 100);
    for (let x = 140; x <= 500; x += 40) touch('touchmove', video, x, 104);
    touch('touchend', document, 500, 104);
    expect(seeks).toEqual([]);
  });
});

describe('a drag that loses its mouseup', () => {
  it('ends the drag when a move arrives with no button held', () => {
    const { inner, seeks, media } = fakePlayer(600, { playing: true });
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 300);
    expect(media.paused).toBe(true);
    // 鼠标已经松开，只是没收到 mouseup
    document.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, buttons: 0, clientX: 350 })
    );
    expect(seeks).toEqual([375]);
    expect(media.plays).toBe(1);
  });

  it('ends the drag when the window loses focus during it', () => {
    const { inner, seeks, media } = fakePlayer(600, { playing: true });
    mouse('mousedown', inner, 150);
    mouse('mousemove', document, 300);
    window.dispatchEvent(new Event('blur'));
    expect(seeks).toEqual([300]);
    expect(media.plays).toBe(1);
    expect(media.paused).toBe(false);
  });
});
