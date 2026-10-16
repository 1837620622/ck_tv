import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { readJsonCache, writeCached } from '@/lib/edge-cache';
import {
  allowedCoverUrl,
  coverContentType,
  decryptHuangguoCover,
} from '@/lib/huangguo-image';
import { gateDenyInit, PRIVATE_HEADERS } from '@/lib/region-gate';

export const runtime = 'edge';

const COVER_SECONDS = 604800;
// 与 decryptHuangguoCover 的上限一致；明文图片也要有上限，否则会把任意大小的对象整个读进内存
const MAX_COVER_BYTES = 8 * 1024 * 1024;

// 边读边计数，超过上限就取消读取，返回 null
async function readCapped(
  response: Response,
  limit: number
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) return null;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (!done) {
    const read = await reader.read();
    done = read.done;
    if (read.value) {
      size += read.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(read.value);
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// 上游有时把封面跳到同一个白名单域名的另一个路径（比如补签名、换路径）。
// 手动跟随，每一跳都重新过白名单，最多 3 跳；跳出白名单就放弃。
const COVER_MAX_HOPS = 3;

async function fetchCover(start: string): Promise<Response | null> {
  let current = start;
  for (let hop = 0; hop < COVER_MAX_HOPS; hop += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
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
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      const next = location
        ? allowedCoverUrl(new URL(location, current).toString())
        : '';
      if (!next) return null;
      current = next;
      continue;
    }
    return response;
  }
  return null;
}

export async function GET(request: Request) {
  const denied = await gateDenyInit(request);
  if (denied) {
    return NextResponse.json(denied.body, {
      status: denied.status,
      headers: denied.headers,
    });
  }
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
    headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
    headers.set('CDN-Cache-Control', PRIVATE_HEADERS['CDN-Cache-Control']);
    headers.set('x-ck-cache', 'HIT');
    return new NextResponse(hit.body, { headers });
  }

  try {
    const response = await fetchCover(target);
    if (!response || !response.ok) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const bytes = await readCapped(response, MAX_COVER_BYTES);
    if (!bytes) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
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
      'Cache-Control': PRIVATE_HEADERS['Cache-Control'],
      'CDN-Cache-Control': PRIVATE_HEADERS['CDN-Cache-Control'],
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
