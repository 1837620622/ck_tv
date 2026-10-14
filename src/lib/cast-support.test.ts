import {
  type CastEnvironment,
  castContentType,
  castSupport,
  toAbsoluteUrl,
} from './cast-support';

const UA = {
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  samsungInternet:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  // iPadOS 默认请求桌面版网站，UA 里是 Macintosh，只能靠 vendor 认出 WebKit
  ipadSafariDesktopUa:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  firefoxAndroid:
    'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
};

const env = (userAgent: string, vendor: string): CastEnvironment => ({
  userAgent,
  vendor,
});
const GOOGLE = 'Google Inc.';
const APPLE = 'Apple Computer, Inc.';

describe('castSupport', () => {
  it('uses Chromecast on Chromium browsers on Android and desktop', () => {
    for (const userAgent of [
      UA.androidChrome,
      UA.samsungInternet,
      UA.windowsEdge,
      UA.macChrome,
    ]) {
      expect(castSupport(env(userAgent, GOOGLE))).toEqual({
        engine: 'chromium',
        chromecast: true,
        airplay: false,
      });
    }
  });

  it('uses AirPlay only on WebKit: Safari on Mac and iPhone, and every iOS browser', () => {
    for (const userAgent of [
      UA.iphoneSafari,
      UA.iphoneChrome,
      UA.macSafari,
      UA.ipadSafariDesktopUa,
    ]) {
      expect(castSupport(env(userAgent, APPLE))).toEqual({
        engine: 'webkit',
        chromecast: false,
        airplay: true,
      });
    }
  });

  it('offers neither on Firefox, so the modal falls back to QR and link', () => {
    expect(castSupport(env(UA.firefoxAndroid, ''))).toEqual({
      engine: 'other',
      chromecast: false,
      airplay: false,
    });
  });

  it('does not offer Chromecast inside an Android WebView, which cannot run the Cast sender', () => {
    const webView =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36';
    expect(castSupport(env(webView, GOOGLE)).chromecast).toBe(false);
  });

  it('never offers Chromecast on iOS even when the UA claims Chrome', () => {
    // iOS Chrome 的 UA 不带 Chrome/ 而是 CriOS；即便将来带了，vendor 为 Apple 也应归为 WebKit
    expect(
      castSupport(env('Mozilla/5.0 (iPhone) Chrome/126.0', APPLE)).chromecast
    ).toBe(false);
  });
});

describe('castContentType', () => {
  it('sends HLS for m3u8 addresses, including ones with signed queries', () => {
    expect(castContentType('https://cdn.test/a/index.m3u8?sign=1&t=2')).toBe(
      'application/x-mpegurl'
    );
    expect(castContentType('https://cdn.test/a/index.M3U8')).toBe(
      'application/x-mpegurl'
    );
  });

  it('sends mp4 for mp4 addresses instead of mislabelling them as HLS', () => {
    expect(castContentType('https://cdn.test/movie.mp4')).toBe('video/mp4');
    expect(castContentType('https://cdn.test/movie.MP4?x=1')).toBe('video/mp4');
  });

  it('defaults unknown addresses to HLS, since most upstream sources are m3u8', () => {
    expect(castContentType('https://cdn.test/stream/123')).toBe(
      'application/x-mpegurl'
    );
  });
});

describe('toAbsoluteUrl', () => {
  it('resolves a site-relative cover path against the page it is on', () => {
    expect(
      toAbsoluteUrl('/api/huangguo/cover?u=x', 'https://site.test/play?ep=2')
    ).toBe('https://site.test/api/huangguo/cover?u=x');
  });

  it('keeps absolute addresses and returns empty for missing ones', () => {
    expect(
      toAbsoluteUrl('https://img.test/p.jpg', 'https://site.test/play')
    ).toBe('https://img.test/p.jpg');
    expect(toAbsoluteUrl(undefined, 'https://site.test/play')).toBe('');
    expect(toAbsoluteUrl('', 'https://site.test/play')).toBe('');
  });
});
