// 按浏览器内核决定能用哪种投屏，而不是等失败再报错。
// Google Cast 只在 Chromium 内核（Chrome、Edge、Android 上的 Chrome）里能用；
// iPhone、iPad、Mac 上的 Safari 和所有 iOS 浏览器都是 WebKit，只能用 AirPlay。
// 判断用 navigator.vendor：WebKit 是 "Apple Computer, Inc."，Chromium 是 "Google Inc."，Firefox 为空。

export type CastEngine = 'chromium' | 'webkit' | 'other';

export interface CastEnvironment {
  userAgent: string;
  vendor: string;
}

export interface CastSupport {
  engine: CastEngine;
  chromecast: boolean;
  airplay: boolean;
}

export function castSupport(env: CastEnvironment): CastSupport {
  const webkit = /Apple/i.test(env.vendor);
  // Android 的 WebView（UA 里有 "; wv)"）也带 Chrome/，但不能跑 Cast 发送端
  const chromium =
    !webkit &&
    /Chrome\/|Chromium\//.test(env.userAgent) &&
    !/;\s*wv\)/.test(env.userAgent);
  return {
    engine: webkit ? 'webkit' : chromium ? 'chromium' : 'other',
    chromecast: chromium,
    airplay: webkit,
  };
}

// 电视自己去拉地址，要告诉它格式。站里的源多数是 m3u8，拿不准的也按 HLS 处理。
export function castContentType(url: string): string {
  if (/\.mp4(?:[?#]|$)/i.test(url)) return 'video/mp4';
  return 'application/x-mpegurl';
}

// 相对地址（比如站内封面接口）要先补全成绝对地址，电视才访问得到
export function toAbsoluteUrl(value: string | undefined, base: string): string {
  if (!value) return '';
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}
