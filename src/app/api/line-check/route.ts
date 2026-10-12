import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { playlistHeight } from '@/lib/playlist';
import { fetchPublic, publicHttpUrl } from '@/lib/safe-url';

export const runtime = 'edge';

const EDGE_SECONDS = 60;
const BROWSER_SECONDS = 30;
const MAX_BYTES = 200_000;

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = MAX_BYTES - size;
    const slice = value.byteLength > room ? value.subarray(0, room) : value;
    text += decoder.decode(slice, { stream: true });
    size += slice.byteLength;
  }
  text += decoder.decode();
  try {
    await reader.cancel();
  } catch {
    // 清单读够就停，不跟随里面的分片地址。
  }
  return text;
}

export async function GET(request: Request) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const target = publicHttpUrl(
    new URL(request.url).searchParams.get('u') || ''
  );
  if (!target) {
    return NextResponse.json(
      { ok: false, height: 0, edgeMs: 0 },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const cacheUrl = `https://cktv-cache.local/line-check?u=${encodeURIComponent(
    target.toString()
  )}&v=1`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    return new NextResponse(await hit.text(), {
      headers: {
        ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'HIT',
      },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const started = Date.now();
  try {
    const response = await fetchPublic(target, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      },
      cf: {
        cacheEverything: true,
        cacheTtl: EDGE_SECONDS,
        cacheTtlByStatus: {
          '200-299': EDGE_SECONDS,
          '300-399': 0,
          '400-499': 15,
          '500-599': 0,
        },
      },
    } as RequestInit);
    if (!response || !response.ok) {
      return NextResponse.json(
        { ok: false, height: 0, edgeMs: Date.now() - started },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const text = await readLimited(response);
    const height = playlistHeight(text);
    const ok = text.includes('#EXTM3U');
    const payload = { ok, height, edgeMs: Date.now() - started };
    const body = JSON.stringify(payload);
    if (!ok) {
      return new NextResponse(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    writeJsonCache(ctx, cacheUrl, body, EDGE_SECONDS, BROWSER_SECONDS);
    return new NextResponse(body, {
      headers: {
        ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'MISS',
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, height: 0, edgeMs: 0 },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } finally {
    clearTimeout(timer);
  }
}
