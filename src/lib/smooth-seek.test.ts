import {
  clamp01,
  formatClock,
  installSmoothSeek,
  ratioAt,
  swipeTarget,
} from './smooth-seek';

function fakePlayer(duration = 600) {
  const player = document.createElement('div');
  const progress = document.createElement('div');
  const inner = document.createElement('div');
  const video = document.createElement('video');
  progress.appendChild(inner);
  player.append(video, progress);
  document.body.appendChild(player);
  progress.getBoundingClientRect = () =>
    ({ left: 100, width: 400, top: 0, height: 6 } as DOMRect);
  Object.defineProperty(player, 'clientWidth', { value: 800 });
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
    isRotate: false,
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
  const detach = installSmoothSeek(art);
  return { art, player, progress, inner, video, seeks, bars, handlers, detach };
}

function mouse(type: string, target: EventTarget, clientX: number) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, clientX })
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

  it('leaves a plain click to ArtPlayer', () => {
    const { inner, seeks } = fakePlayer();
    mouse('mousedown', inner, 300);
    mouse('mouseup', document, 300);
    expect(seeks).toEqual([]);
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
