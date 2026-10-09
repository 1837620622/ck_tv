import { getOptionalRequestContext } from '@cloudflare/next-on-pages';

import { readJsonCache, writeCached } from '@/lib/edge-cache';

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

function fallback() {
  return new Response(FALLBACK_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function privateIPv4(parts: number[]): boolean {
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function expandIPv6(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): string[] | null => {
    if (!side) return [];
    const out: string[] = [];
    for (const bit of side.split(':')) {
      if (bit.includes('.')) {
        const nums = bit.split('.').map((part) => Number(part));
        if (
          nums.length !== 4 ||
          nums.some((part) => !Number.isInteger(part) || part > 255)
        ) {
          return null;
        }
        out.push(((nums[0] << 8) | nums[1]).toString(16));
        out.push(((nums[2] << 8) | nums[3]).toString(16));
        continue;
      }
      if (!/^[0-9a-f]{0,4}$/i.test(bit)) return null;
      out.push(bit || '0');
    }
    return out;
  };

  const left = parseSide(halves[0]);
  if (!left) return null;
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    return left.map((part) => parseInt(part, 16));
  }
  const right = parseSide(halves[1]);
  if (!right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array(missing).fill('0'), ...right].map((part) =>
    parseInt(part, 16)
  );
}

function ipv4FromPair(hi: number, lo: number): number[] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

function blockedIPv6(host: string): boolean {
  const nums = expandIPv6(host);
  if (!nums || nums.some((part) => Number.isNaN(part) || part > 0xffff)) {
    return true;
  }
  const loopback =
    nums.every((part) => part === 0) ||
    (nums.slice(0, 7).every((part) => part === 0) && nums[7] === 1);
  if (loopback) return true;
  const head = nums[0];
  // fe80::/10、fec0::/10、ff00::/8、fc00::/7
  if (head >= 0xfe80 && head <= 0xfeff) return true;
  if (head >= 0xff00) return true;
  if (head >= 0xfc00 && head <= 0xfdff) return true;

  let embedded: number[] | null = null;
  if (nums.slice(0, 5).every((part) => part === 0) && nums[5] === 0xffff) {
    embedded = ipv4FromPair(nums[6], nums[7]);
  } else if (nums.slice(0, 6).every((part) => part === 0)) {
    embedded = ipv4FromPair(nums[6], nums[7]);
  } else if (head === 0x2002) {
    embedded = ipv4FromPair(nums[1], nums[2]);
  } else if (
    head === 0x64 &&
    nums[1] === 0xff9b &&
    nums.slice(2, 6).every((part) => part === 0)
  ) {
    embedded = ipv4FromPair(nums[6], nums[7]);
  }
  return embedded ? privateIPv4(embedded) : false;
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
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
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
    const parts = ipv4.slice(1).map((part) => Number(part));
    if (privateIPv4(parts)) return null;
  }
  if (host.includes(':') && blockedIPv6(host)) return null;
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
      headers,
      signal,
      redirect: 'manual',
      // 只缓存最终图片。重定向不进缓存，避免把临时跳转钉住。
      cf: {
        cacheEverything: true,
        cacheTtl: 604800,
        cacheTtlByStatus: {
          '200-299': 604800,
          '300-399': 0,
          '400-499': 60,
          '500-599': 0,
        },
      },
    } as RequestInit);
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
    return fallback();
  }

  const target = safeImageUrl(imageUrl);
  if (!target) {
    return fallback();
  }

  const cacheUrl = `https://cktv-cache.local/img?u=${encodeURIComponent(
    target.toString()
  )}`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-ck-cache', 'HIT');
    return new Response(hit.body, { status: 200, headers });
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

    const mime = (imageResponse.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const imageType =
      (mime.startsWith('image/') && mime !== 'image/svg+xml') ||
      mime === 'application/octet-stream';
    if (!imageResponse.ok || !imageResponse.body || !imageType) {
      return fallback();
    }
    const resHeaders = new Headers();
    resHeaders.set(
      'Content-Type',
      mime === 'application/octet-stream' ? 'image/jpeg' : mime
    );
    resHeaders.set('X-Content-Type-Options', 'nosniff');
    resHeaders.set(
      'Cache-Control',
      'public, max-age=15720000, s-maxage=15720000'
    );
    resHeaders.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    resHeaders.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');
    resHeaders.set('x-ck-cache', 'MISS');

    const length = Number(imageResponse.headers.get('content-length') || '0');
    const out = new Response(imageResponse.body, {
      status: 200,
      headers: resHeaders,
    });
    // 未知长度或 2MB 以内的海报放进 Cache API。更大的文件只靠上面的子请求缓存。
    if (length === 0 || length < 2_000_000) {
      const ctx = (() => {
        try {
          return getOptionalRequestContext()?.ctx;
        } catch {
          return undefined;
        }
      })();
      writeCached(ctx, cacheUrl, out.clone());
    }
    return out;
  } catch (_error) {
    return fallback();
  }
}
