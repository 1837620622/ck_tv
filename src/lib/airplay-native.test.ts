import {
  isAirPlaying,
  loadNativeSource,
  supportsNativeHls,
  watchAirPlayTargets,
} from './airplay';

// 替身：读取 currentTime / paused 会得到 live 值，set 会被记录，play 与 load 不真正播放
function makeVideo(options: { paused?: boolean; time?: number } = {}) {
  const video = document.createElement('video');
  const setTime = jest.fn();
  Object.defineProperty(video, 'currentTime', {
    get: () => options.time ?? 0,
    set: setTime,
    configurable: true,
  });
  Object.defineProperty(video, 'paused', {
    get: () => options.paused ?? true,
    configurable: true,
  });
  video.load = jest.fn();
  video.play = jest.fn(() => Promise.resolve());
  return { video, setTime };
}

describe('supportsNativeHls', () => {
  it('is false where the browser cannot play HLS natively (Chromium)', () => {
    const { video } = makeVideo();
    video.canPlayType = jest.fn(() => '');
    expect(supportsNativeHls(video)).toBe(false);
  });

  it('is true where native HLS is available (Safari)', () => {
    const { video } = makeVideo();
    video.canPlayType = jest.fn(() => 'maybe');
    expect(supportsNativeHls(video)).toBe(true);
    expect(video.canPlayType).toHaveBeenCalledWith(
      'application/vnd.apple.mpegurl'
    );
  });
});

describe('loadNativeSource', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('switches to the raw address and resumes when the snapshot says it was playing', async () => {
    const { video, setTime } = makeVideo();
    const pending = loadNativeSource(video, 'https://cdn.test/a.m3u8', {
      at: 0,
      resume: true,
    });
    expect(video.src).toBe('https://cdn.test/a.m3u8');
    expect(video.load).toHaveBeenCalledTimes(1);

    video.dispatchEvent(new Event('loadedmetadata'));
    await expect(pending).resolves.toBe(true);
    expect(setTime).not.toHaveBeenCalled();
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('restores the snapshot playhead and stays paused when the snapshot says it was paused', async () => {
    const { video, setTime } = makeVideo({ paused: true, time: 0 });
    const pending = loadNativeSource(video, 'https://cdn.test/a.m3u8', {
      at: 42,
      resume: false,
    });
    video.dispatchEvent(new Event('loadedmetadata'));
    await pending;
    expect(setTime).toHaveBeenCalledWith(42);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('uses the caller snapshot, not the live playhead, which the switch may have reset', async () => {
    // 销毁 hls.js 后 currentTime 已经是 0；恢复时必须用调用方记下的 42
    const { video, setTime } = makeVideo({ time: 0 });
    const pending = loadNativeSource(video, 'https://cdn.test/a.m3u8', {
      at: 42,
      resume: false,
    });
    video.dispatchEvent(new Event('loadedmetadata'));
    await pending;
    expect(setTime).toHaveBeenCalledWith(42);
  });

  it('resolves false when the native load fails', async () => {
    const { video } = makeVideo();
    const pending = loadNativeSource(video, 'https://cdn.test/a.m3u8', {
      at: 0,
      resume: false,
    });
    video.dispatchEvent(new Event('error'));
    await expect(pending).resolves.toBe(false);
  });

  it('resolves false when metadata never arrives in time', async () => {
    jest.useFakeTimers();
    const { video } = makeVideo();
    const pending = loadNativeSource(video, 'https://cdn.test/a.m3u8', {
      at: 0,
      resume: false,
      timeoutMs: 8000,
    });
    jest.advanceTimersByTime(8000);
    await expect(pending).resolves.toBe(false);
  });
});

describe('isAirPlaying', () => {
  it('is true only while the playback target is a wireless device', () => {
    const { video } = makeVideo();
    expect(isAirPlaying(video)).toBe(false);
    Object.assign(video, { webkitCurrentPlaybackTargetIsWireless: true });
    expect(isAirPlaying(video)).toBe(true);
  });
});

describe('watchAirPlayTargets', () => {
  function availabilityEvent(availability: string) {
    const event = new Event('webkitplaybacktargetavailabilitychanged');
    Object.assign(event, { availability });
    return event;
  }

  it('reports whether an AirPlay target is available', () => {
    const { video } = makeVideo();
    const onChange = jest.fn();
    watchAirPlayTargets(video, onChange);

    video.dispatchEvent(availabilityEvent('available'));
    video.dispatchEvent(availabilityEvent('not-available'));
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('stops reporting after unsubscribe', () => {
    const { video } = makeVideo();
    const onChange = jest.fn();
    const stop = watchAirPlayTargets(video, onChange);
    stop();
    video.dispatchEvent(availabilityEvent('available'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
