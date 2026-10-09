import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import {
  detailHuangguo,
  HUANGGUO_CATEGORIES,
  listHuangguo,
  searchHuangguo,
} from '@/lib/huangguo';

export const runtime = 'edge';

const EDGE_SECONDS = 900;
const BROWSER_SECONDS = 60;

function asPage(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export async function GET(request: Request) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const page = asPage(searchParams.get('page'));
  const category = searchParams.get('t') || 'hot';

  if (action === 'detail') {
    const id = searchParams.get('id') || '';
    const detailCacheUrl = `https://cktv-cache.local/huangguo-detail?id=${encodeURIComponent(
      id
    )}&v=1`;
    const detailHit = await readJsonCache(detailCacheUrl);
    if (detailHit) {
      return new NextResponse(await detailHit.text(), {
        headers: {
          ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
          'content-type': 'application/json; charset=utf-8',
          'x-ck-cache': 'HIT',
        },
      });
    }
    try {
      const detail = await detailHuangguo(id);
      const body = JSON.stringify(detail);
      if (detail.episodes.length > 0) {
        writeJsonCache(
          ctx,
          detailCacheUrl,
          body,
          EDGE_SECONDS,
          BROWSER_SECONDS
        );
      }
      return new NextResponse(body, {
        headers: {
          ...(detail.episodes.length > 0
            ? jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS)
            : { 'Cache-Control': 'no-store' }),
          'content-type': 'application/json; charset=utf-8',
          'x-ck-cache': 'MISS',
        },
      });
    } catch (error) {
      return NextResponse.json(
        { error: (error as Error).message, episodes: [] },
        { status: 404, headers: { 'Cache-Control': 'no-store' } }
      );
    }
  }

  const query = (searchParams.get('q') || '').trim();
  const cacheUrl = `https://cktv-cache.local/huangguo?action=${action}&t=${encodeURIComponent(
    category
  )}&q=${encodeURIComponent(query)}&page=${page}&v=1`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    return new NextResponse(await hit.text(), {
      headers: {
        ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
        'x-ck-cache': 'HIT',
      },
    });
  }

  try {
    const payload =
      action === 'search' && query
        ? await searchHuangguo(query, page)
        : await listHuangguo(category, page);
    const body = JSON.stringify({
      ...payload,
      categories: HUANGGUO_CATEGORIES,
    });
    if (payload.list.length === 0) {
      return new NextResponse(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'x-ck-cache': 'EMPTY',
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
  } catch (error) {
    return NextResponse.json(
      {
        list: [],
        page,
        pagecount: 1,
        categories: HUANGGUO_CATEGORIES,
        error: (error as Error).message,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
