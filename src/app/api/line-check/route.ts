import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { playlistHeight } from '@/lib/playlist';

export const runtime = 'edge';

const EDGE_SECONDS = 60;
const BROWSER_SECONDS = 30;
const MAX_BYTES = 200_000;

function safePlayUrl(raw: string): URL | null {
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
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number(part));
    const [a, b] = parts;
    const blocked =
      a === 10 ||
      a === 127 ||
      a === 0 ||
      a >= 224 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254);
    if (blocked || parts.some((part) => part > 255)) return null;
  }
  if (host.includes(':')) return null;
  return url;
}

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
  const target = safePlayUrl(new URL(request.url).searchParams.get('u') || '');
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
    let current = target;
    let response: Response | null = null;
    for (let hop = 0; hop < 3; hop += 1) {
      response = await fetch(current.toString(), {
        signal: controller.signal,
        redirect: 'manual',
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
      if (response.status < 300 || response.status >= 400) break;
      const next = safePlayUrl(
        new URL(response.headers.get('location') || '', current).toString()
      );
      if (!next) {
        response = null;
        break;
      }
      current = next;
    }
    if (!response) {
      return NextResponse.json(
        { ok: false, height: 0, edgeMs: Date.now() - started },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }
    if (!response.ok) {
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
