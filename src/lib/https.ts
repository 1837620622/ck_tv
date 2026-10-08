// 只把 Cookie 升到 Secure，不因为反代少带协议头而降回去。
export function isHttpsRequest(req: {
  url: string;
  headers: Headers;
  nextUrl?: { protocol: string };
}): boolean {
  if (req.nextUrl?.protocol === 'https:') return true;
  const forwarded = (req.headers.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim();
  if (forwarded === 'https') return true;
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}
