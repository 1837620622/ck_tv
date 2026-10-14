import { getOptionalRequestContext } from '@cloudflare/next-on-pages';

import { readJsonCache, writeCached } from '@/lib/edge-cache';
import { limitStream } from '@/lib/limit-stream';
import { fetchPublic, publicHttpUrl } from '@/lib/safe-url';

export const runtime = 'edge';

// 海报一般几百 KB。声明了长度且超过的直接不代理；没有声明长度的，读到这个上限就中断，
// 免得被拿来当流量出口
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// 等响应头的时间
const HEADER_TIMEOUT_MS = 8000;
// 读响应体时两块数据之间最多等多久；慢但在持续出数据的图片不会被切断
const BODY_IDLE_TIMEOUT_MS = 8000;

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

// OrionTV 兼容与防盗链代理接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return fallback();
  }

  const target = publicHttpUrl(imageUrl);
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

    // 只管等响应头；响应头到了就清掉，读响应体的超时交给 limitStream 的空闲检查
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
    // 只缓存最终图片。重定向不进缓存，避免把临时跳转钉住。
    const imageResponse = await fetchPublic(target, {
      headers,
      signal: controller.signal,
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
    const length = Number(imageResponse.headers.get('content-length') || '0');
    if (
      !imageResponse.ok ||
      !imageResponse.body ||
      !imageType ||
      length > MAX_IMAGE_BYTES
    ) {
      imageResponse.body?.cancel().catch(() => undefined);
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

    // 读取时同样限制大小，超限或长时间没有新数据就中断
    const body = limitStream(imageResponse.body, {
      maxBytes: MAX_IMAGE_BYTES,
      idleMs: BODY_IDLE_TIMEOUT_MS,
    });
    const out = new Response(body, {
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
