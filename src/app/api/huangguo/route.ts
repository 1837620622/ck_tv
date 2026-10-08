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
    try {
      const detail = await detailHuangguo(id);
      return NextResponse.json(detail, {
        headers: jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
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
    if (payload.list.length > 0) {
      writeJsonCache(ctx, cacheUrl, body, EDGE_SECONDS, BROWSER_SECONDS);
    }
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
