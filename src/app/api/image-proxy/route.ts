import { edgeFetchInit } from '@/lib/edge-cache';

export const runtime = 'edge';

const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="100%" height="100%">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="50%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
  </defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <circle cx="200" cy="260" r="48" fill="#334155" opacity="0.6"/>
  <path d="M185 240 L225 260 L185 280 Z" fill="#22c55e" opacity="0.9"/>
  <text x="200" y="350" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="18" fill="#94a3b8" text-anchor="middle" font-weight="600">CK TV</text>
  <text x="200" y="380" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="12" fill="#64748b" text-anchor="middle">影视海报</text>
</svg>`;

function fallback(cacheSeconds = 3600) {
  return new Response(FALLBACK_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': `public, max-age=${cacheSeconds}`,
    },
  });
}

// 只允许公网 http(s) 图片。挡住内网、云元数据地址和任意网页代理。
function safeImageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return null;
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const parts = [a, b, Number(ipv4[3]), Number(ipv4[4])];
    if (parts.some((part) => part > 255)) return null;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return null;
    }
  }
  if (host.includes(':')) {
    if (
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80')
    ) {
      return null;
    }
  }
  return url;
}

async function fetchPublicImage(
  start: URL,
  headers: HeadersInit,
  signal: AbortSignal
): Promise<Response | null> {
  let current = start;
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetch(current.toString(), {
      ...edgeFetchInit(headers, signal, 86400),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      const next = safeImageUrl(new URL(location, current).toString());
      if (!next) return null;
      current = next;
      continue;
    }
    return response;
  }
  return null;
}

// OrionTV 兼容与防盗链代理接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return fallback(3600);
  }

  const target = safeImageUrl(imageUrl);
  if (!target) {
    return fallback(60);
  }

  try {
    const isDouban = target.hostname.includes('doubanio.com');
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    };
    if (isDouban) {
      headers['Referer'] = 'https://movie.douban.com/';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const imageResponse = await fetchPublicImage(
      target,
      headers,
      controller.signal
    );
    clearTimeout(timeoutId);

    if (!imageResponse) {
      return fallback();
    }

    const contentType = (
      imageResponse.headers.get('content-type') || ''
    ).toLowerCase();
    const imageType =
      contentType.startsWith('image/') ||
      contentType.startsWith('application/octet-stream') ||
      contentType === '';
    if (!imageResponse.ok || !imageResponse.body || !imageType) {
      return fallback();
    }
    const resHeaders = new Headers();
    resHeaders.set('Content-Type', contentType || 'image/jpeg');
    resHeaders.set(
      'Cache-Control',
      'public, max-age=15720000, s-maxage=15720000'
    );
    resHeaders.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    resHeaders.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');

    return new Response(imageResponse.body, {
      status: 200,
      headers: resHeaders,
    });
  } catch (_error) {
    return fallback();
  }
}
