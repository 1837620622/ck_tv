import {
  type CastRequestPlan,
  buildCastRequest,
  CAST_SDK_URL,
  castSdkReady,
  HLS_CONTENT_TYPE,
  loadCastSdk,
  observeCast,
  startCast,
  stopCast,
} from './cast';

type Win = NonNullable<Parameters<typeof startCast>[1]>;
const asWin = (value: object) => value as unknown as Win;

class FakeMediaInfo {
  streamType = '';
  metadata: FakeMetadata | null = null;
  constructor(public contentId: string, public contentType: string) {}
}

class FakeImage {
  constructor(public url: string) {}
}

class FakeMetadata {
  title = '';
  images: FakeImage[] = [];
}

class FakeLoadRequest {
  autoplay = false;
  currentTime = 0;
  constructor(public media: FakeMediaInfo) {}
}

// 模拟 Cast SDK 的发送端对象。connected 为 false 时还没有选中设备
function fakeCast(options: { connected?: boolean; cancel?: boolean } = {}) {
  const loadMedia = jest.fn(async (_request: FakeLoadRequest) => undefined);
  const endSession = jest.fn();
  const session = {
    loadMedia,
    endSession,
    getCastDevice: () => ({ friendlyName: '客厅电视' }),
  };
  let current: typeof session | null =
    options.connected === false ? null : session;
  const context = {
    setOptions: jest.fn(),
    requestSession: jest.fn(async () => {
      if (options.cancel) {
        throw Object.assign(new Error('cancel'), { code: 'cancel' });
      }
      current = session;
    }),
    getCurrentSession: () => current,
    getCastState: jest.fn(() => (current ? 'CONNECTED' : 'NOT_CONNECTED')),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  };
  const win = asWin({
    cast: {
      framework: {
        CastContext: { getInstance: () => context },
        CastState: { CONNECTED: 'CONNECTED' },
        CastContextEventType: { CAST_STATE_CHANGED: 'CAST_STATE_CHANGED' },
      },
    },
    chrome: {
      cast: {
        AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
        Image: FakeImage,
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
          StreamType: { BUFFERED: 'BUFFERED' },
          MediaInfo: FakeMediaInfo,
          GenericMediaMetadata: FakeMetadata,
          LoadRequest: FakeLoadRequest,
        },
      },
    },
  });
  return { win, context, loadMedia, endSession };
}

const plan: CastRequestPlan = {
  contentUrl: 'https://cdn.example.com/a/index.m3u8?sign=1',
  contentType: HLS_CONTENT_TYPE,
  title: '第一集',
  images: ['https://img.example.com/p.jpg'],
  currentTime: 83,
};

describe('buildCastRequest', () => {
  it('keeps only absolute http(s) addresses the TV can reach', () => {
    expect(buildCastRequest({ url: '/api/proxy?u=x', title: 't' })).toBeNull();
    expect(
      buildCastRequest({ url: 'blob:https://x/abc', title: 't' })
    ).toBeNull();
    expect(buildCastRequest({ url: '', title: 't' })).toBeNull();
    expect(
      buildCastRequest({
        url: ' https://cdn.example.com/a.m3u8 ',
        title: 't',
      })?.contentUrl
    ).toBe('https://cdn.example.com/a.m3u8');
  });

  it('falls back to a default title and drops a relative poster', () => {
    const built = buildCastRequest({
      url: 'https://cdn.example.com/a.m3u8',
      title: '',
      poster: '/cover.jpg',
    });
    expect(built).toMatchObject({
      title: '传康播放器',
      images: [],
      contentType: HLS_CONTENT_TYPE,
    });
  });

  it('keeps an absolute poster and clamps the start time', () => {
    const url = 'https://cdn.example.com/a.m3u8';
    expect(
      buildCastRequest({
        url,
        title: 't',
        poster: 'https://img.example.com/p.jpg',
      })?.images
    ).toEqual(['https://img.example.com/p.jpg']);
    expect(
      buildCastRequest({ url, title: 't', currentTime: -3 })?.currentTime
    ).toBe(0);
    expect(
      buildCastRequest({ url, title: 't', currentTime: NaN })?.currentTime
    ).toBe(0);
    expect(
      buildCastRequest({ url, title: 't', currentTime: 42.5 })?.currentTime
    ).toBe(42.5);
  });
});

describe('castSdkReady', () => {
  it('needs both the framework and the chrome.cast namespace', () => {
    expect(castSdkReady(asWin({}))).toBe(false);
    expect(castSdkReady(asWin({ cast: { framework: {} } }))).toBe(false);
    expect(
      castSdkReady(asWin({ cast: { framework: {} }, chrome: { cast: {} } }))
    ).toBe(true);
  });
});

describe('loadCastSdk', () => {
  const globals = window as unknown as {
    cast?: unknown;
    chrome?: unknown;
    __onGCastApiAvailable?: (available: boolean) => void;
  };
  const installSdk = () => {
    globals.cast = { framework: {} };
    globals.chrome = { cast: {} };
  };

  afterEach(() => {
    delete globals.cast;
    delete globals.chrome;
    delete globals.__onGCastApiAvailable;
    document.head.innerHTML = '';
    jest.useRealTimers();
  });

  it('resolves at once without fetching when the SDK is already there', async () => {
    installSdk();
    await expect(loadCastSdk(window as unknown as Win)).resolves.toBe(true);
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('injects the sender script and resolves once the SDK is ready', async () => {
    const pending = loadCastSdk(window as unknown as Win);
    const script = document.head.querySelector<HTMLScriptElement>('script');
    expect(script?.src).toBe(CAST_SDK_URL);
    installSdk();
    globals.__onGCastApiAvailable?.(true);
    await expect(pending).resolves.toBe(true);
  });

  it('resolves false when the SDK reports it is unavailable', async () => {
    const pending = loadCastSdk(window as unknown as Win);
    globals.__onGCastApiAvailable?.(false);
    await expect(pending).resolves.toBe(false);
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('gives up after 15 seconds and removes the script so a retry can add it again', async () => {
    jest.useFakeTimers();
    const pending = loadCastSdk(window as unknown as Win);
    expect(document.head.querySelectorAll('script')).toHaveLength(1);
    jest.advanceTimersByTime(15000);
    await expect(pending).resolves.toBe(false);
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });

  it('resolves false when the script cannot be downloaded', async () => {
    const pending = loadCastSdk(window as unknown as Win);
    const script = document.head.querySelector<HTMLScriptElement>('script');
    script?.dispatchEvent(new Event('error'));
    await expect(pending).resolves.toBe(false);
    expect(document.head.querySelectorAll('script')).toHaveLength(0);
  });
});

describe('startCast', () => {
  it('sends the HLS address, title, poster and start time to the TV', async () => {
    const { win, loadMedia, context } = fakeCast();
    await expect(startCast(plan, win)).resolves.toEqual({
      device: '客厅电视',
    });
    expect(context.requestSession).not.toHaveBeenCalled();
    expect(context.setOptions).toHaveBeenCalledWith(
      expect.objectContaining({ receiverApplicationId: 'CC1AD845' })
    );

    const request = loadMedia.mock.calls[0][0];
    expect(request.autoplay).toBe(true);
    expect(request.currentTime).toBe(83);
    expect(request.media.contentId).toBe(plan.contentUrl);
    expect(request.media.contentType).toBe('application/x-mpegurl');
    expect(request.media.streamType).toBe('BUFFERED');
    expect(request.media.metadata?.title).toBe('第一集');
    expect(request.media.metadata?.images.map((image) => image.url)).toEqual([
      'https://img.example.com/p.jpg',
    ]);
  });

  it('asks for a device first when none is selected', async () => {
    const { win, context, loadMedia } = fakeCast({ connected: false });
    await startCast(plan, win);
    expect(context.requestSession).toHaveBeenCalledTimes(1);
    expect(loadMedia).toHaveBeenCalledTimes(1);
  });

  it('lets the user cancel the device picker and passes the error through', async () => {
    const { win, loadMedia } = fakeCast({ connected: false, cancel: true });
    await expect(startCast(plan, win)).rejects.toMatchObject({
      code: 'cancel',
    });
    expect(loadMedia).not.toHaveBeenCalled();
  });

  it('reads the playhead after the device is chosen, not before', async () => {
    const { win, context, loadMedia } = fakeCast({ connected: false });
    const readTime = jest.fn(() => 120);
    await startCast(plan, win, readTime);
    expect(readTime).toHaveBeenCalledTimes(1);
    expect(context.requestSession.mock.invocationCallOrder[0]).toBeLessThan(
      readTime.mock.invocationCallOrder[0]
    );
    expect(loadMedia.mock.calls[0][0].currentTime).toBe(120);
  });

  it('starts from zero when the playhead reads as negative', async () => {
    const { win, loadMedia } = fakeCast();
    await startCast(plan, win, () => -1);
    expect(loadMedia.mock.calls[0][0].currentTime).toBe(0);
  });

  it('throws a readable error when the SDK has not loaded', async () => {
    await expect(startCast(plan, asWin({}))).rejects.toThrow(
      '投屏组件还没有加载'
    );
  });
});

describe('stopCast', () => {
  it('ends the current session', () => {
    const { win, endSession } = fakeCast();
    stopCast(win);
    expect(endSession).toHaveBeenCalledWith(true);
  });

  it('does nothing when the SDK has not loaded', () => {
    expect(() => stopCast(asWin({}))).not.toThrow();
  });
});

describe('observeCast', () => {
  it('reports the connection state and stops listening after unsubscribe', () => {
    const { win, context } = fakeCast();
    const onChange = jest.fn();
    const stop = observeCast(onChange, win);

    expect(context.addEventListener).toHaveBeenCalledWith(
      'CAST_STATE_CHANGED',
      expect.any(Function)
    );
    const handler = context.addEventListener.mock.calls[0][1];
    handler();
    expect(onChange).toHaveBeenLastCalledWith({
      connected: true,
      device: '客厅电视',
    });

    stop();
    expect(context.removeEventListener).toHaveBeenCalledWith(
      'CAST_STATE_CHANGED',
      handler
    );
  });

  it('reports disconnected with no device name', () => {
    const { win, context } = fakeCast({ connected: false });
    const onChange = jest.fn();
    observeCast(onChange, win);
    context.addEventListener.mock.calls[0][1]();
    expect(onChange).toHaveBeenLastCalledWith({ connected: false, device: '' });
  });

  it('returns a no-op when the SDK has not loaded', () => {
    expect(() => observeCast(jest.fn(), asWin({}))()).not.toThrow();
  });
});
