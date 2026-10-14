import {
  bindMediaActions,
  setMediaInfo,
  setMediaPlaybackState,
  setMediaPosition,
} from './media-session';

type Handler = (() => void) | null;

function fakeSession() {
  return {
    metadata: null as unknown,
    playbackState: 'none' as string,
    setActionHandler: jest.fn((action: string, _handler: Handler) => {
      if (action === 'unknownaction') throw new TypeError('unsupported');
    }),
    setPositionState: jest.fn(),
  };
}

class FakeMetadata {
  constructor(
    public init: { title: string; album?: string; artwork?: unknown[] }
  ) {}
}

describe('media session helpers', () => {
  const originalMediaSession = Object.getOwnPropertyDescriptor(
    navigator,
    'mediaSession'
  );

  afterEach(() => {
    if (originalMediaSession) {
      Object.defineProperty(navigator, 'mediaSession', originalMediaSession);
    } else {
      delete (navigator as { mediaSession?: unknown }).mediaSession;
    }
    delete (globalThis as { MediaMetadata?: unknown }).MediaMetadata;
  });

  it('does nothing when the browser has no media session', () => {
    delete (navigator as { mediaSession?: unknown }).mediaSession;
    expect(() => {
      setMediaInfo({ title: '测试' });
      setMediaPlaybackState('playing');
      setMediaPosition({ position: 1, duration: 10, playbackRate: 1 });
      bindMediaActions({
        play: jest.fn(),
        pause: jest.fn(),
        seekBackward: jest.fn(),
        seekForward: jest.fn(),
      })();
    }).not.toThrow();
  });

  it('publishes the title, album and one artwork per common size', () => {
    const session = fakeSession();
    Object.defineProperty(navigator, 'mediaSession', {
      value: session,
      configurable: true,
    });
    (globalThis as { MediaMetadata?: unknown }).MediaMetadata = FakeMetadata;

    setMediaInfo({
      title: '流浪地球2',
      album: '示例源',
      artwork: 'https://img.test/p.jpg',
    });
    const metadata = session.metadata as FakeMetadata;
    expect(metadata.init.title).toBe('流浪地球2');
    expect(metadata.init.album).toBe('示例源');
    expect(metadata.init.artwork).toHaveLength(3);
  });

  it('sets playback state directly', () => {
    const session = fakeSession();
    Object.defineProperty(navigator, 'mediaSession', {
      value: session,
      configurable: true,
    });
    setMediaPlaybackState('paused');
    expect(session.playbackState).toBe('paused');
  });

  it('only reports a position when the duration is known and the position fits', () => {
    const session = fakeSession();
    Object.defineProperty(navigator, 'mediaSession', {
      value: session,
      configurable: true,
    });

    setMediaPosition({ position: 5, duration: NaN, playbackRate: 1 });
    setMediaPosition({ position: 5, duration: 0, playbackRate: 1 });
    setMediaPosition({ position: 20, duration: 10, playbackRate: 1 });
    expect(session.setPositionState).not.toHaveBeenCalled();

    setMediaPosition({ position: 5, duration: 10, playbackRate: 0 });
    expect(session.setPositionState).toHaveBeenCalledWith({
      duration: 10,
      playbackRate: 1,
      position: 5,
    });
  });

  it('binds the lock-screen buttons, clears missing ones, and unbinds', () => {
    const session = fakeSession();
    Object.defineProperty(navigator, 'mediaSession', {
      value: session,
      configurable: true,
    });
    const play = jest.fn();
    const unbind = bindMediaActions({
      play,
      pause: jest.fn(),
      seekBackward: jest.fn(),
      seekForward: jest.fn(),
    });

    const calls = session.setActionHandler.mock.calls as [string, Handler][];
    expect(calls.find(([action]) => action === 'play')?.[1]).toBe(play);
    // 没有上一集、下一集时要显式清掉，锁屏上不留死按钮
    expect(
      calls.find(([action]) => action === 'previoustrack')?.[1]
    ).toBeNull();
    expect(calls.find(([action]) => action === 'nexttrack')?.[1]).toBeNull();

    session.setActionHandler.mockClear();
    unbind();
    const cleared = session.setActionHandler.mock.calls as [string, Handler][];
    expect(cleared.every(([, handler]) => handler === null)).toBe(true);
  });

  it('keeps binding the other buttons when one action is rejected', () => {
    const session = fakeSession();
    session.setActionHandler.mockImplementation((action: string) => {
      if (action === 'seekforward') throw new TypeError('unsupported');
    });
    Object.defineProperty(navigator, 'mediaSession', {
      value: session,
      configurable: true,
    });
    const play = jest.fn();
    expect(() =>
      bindMediaActions({
        play,
        pause: jest.fn(),
        seekBackward: jest.fn(),
        seekForward: jest.fn(),
      })
    ).not.toThrow();
    const bound = (
      session.setActionHandler.mock.calls as [string, Handler][]
    ).map(([action]) => action);
    expect(bound).toEqual(
      expect.arrayContaining([
        'play',
        'pause',
        'seekbackward',
        'previoustrack',
        'nexttrack',
      ])
    );
  });
});
