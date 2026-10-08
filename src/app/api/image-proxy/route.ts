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

// OrionTV 兼容与防盗链代理接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return new Response(FALLBACK_SVG, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml' },
    });
  }

  try {
    const isDouban = imageUrl.includes('doubanio.com');
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    };
    if (isDouban) {
      headers['Referer'] = 'https://movie.douban.com/';
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const imageResponse = await fetch(
      imageUrl,
      edgeFetchInit(headers, controller.signal, 86400)
    );
    clearTimeout(timeoutId);

    if (!imageResponse.ok || !imageResponse.body) {
      return new Response(FALLBACK_SVG, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    const contentType =
      imageResponse.headers.get('content-type') || 'image/jpeg';
    const resHeaders = new Headers();
    resHeaders.set('Content-Type', contentType);
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
    return new Response(FALLBACK_SVG, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
}
