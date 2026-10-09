import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { readJsonCache, writeCached } from '@/lib/edge-cache';
import {
  allowedCoverUrl,
  coverContentType,
  decryptHuangguoCover,
} from '@/lib/huangguo-image';

export const runtime = 'edge';

const COVER_SECONDS = 604800;

export async function GET(request: Request) {
  const target = allowedCoverUrl(
    new URL(request.url).searchParams.get('u') || ''
  );
  if (!target) {
    return NextResponse.json({ error: '封面地址无效' }, { status: 400 });
  }

  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const cacheUrl = `https://cktv-cache.local/hg-cover?u=${encodeURIComponent(
    target
  )}`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-ck-cache', 'HIT');
    return new NextResponse(hit.body, { headers });
  }

  try {
    const response = await fetch(target, {
      headers: {
        Accept: 'image/*,*/*',
        Referer: 'https://huangguoai.com/',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      },
      cf: {
        cacheEverything: true,
        cacheTtl: COVER_SECONDS,
        cacheTtlByStatus: {
          '200-299': COVER_SECONDS,
          '400-499': 60,
          '500-599': 0,
        },
      },
    } as RequestInit);
    if (!response.ok) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const image = decryptHuangguoCover(bytes);
    const type = image ? coverContentType(image) : '';
    if (!image || !type) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const headers = {
      'Content-Type': type,
      'Cache-Control': `public, max-age=86400, s-maxage=${COVER_SECONDS}`,
      'CDN-Cache-Control': `public, s-maxage=${COVER_SECONDS}`,
      'X-Content-Type-Options': 'nosniff',
      'x-ck-cache': 'MISS',
    };
    writeCached(
      ctx,
      cacheUrl,
      new Response(image.slice(), {
        headers: {
          ...headers,
          'cache-control': `public, max-age=${COVER_SECONDS}`,
        },
      })
    );
    return new NextResponse(new Blob([image]), { headers });
  } catch {
    return new NextResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
