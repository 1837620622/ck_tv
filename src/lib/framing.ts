// 页面和接口都不允许被其它网站嵌进 iframe，防止点击劫持（把播放器或口令框藏在别人的页面下面诱导点击）。
export const FRAMING_HEADERS: Record<string, string> = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
};
