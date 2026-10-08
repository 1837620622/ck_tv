import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getAdultApiSites, getAvailableApiSites } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';

export const runtime = 'edge';

const DETAIL_EDGE_SECONDS = 600;
const DETAIL_BROWSER_SECONDS = 120;

export async function GET(request: Request) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites();
    let apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      const adultSites = await getAdultApiSites();
      apiSite = adultSites.find((site) => site.key === sourceCode);
    }

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const cacheUrl = `https://cktv-cache.local/detail?source=${encodeURIComponent(
      sourceCode
    )}&id=${encodeURIComponent(id)}&v=5`;
    const hit = await readJsonCache(cacheUrl);
    if (hit) {
      return new NextResponse(await hit.text(), {
        headers: {
          ...jsonCacheHeaders(DETAIL_EDGE_SECONDS, DETAIL_BROWSER_SECONDS),
          'x-ck-cache': 'HIT',
        },
      });
    }

    const result = await getDetailFromApi(apiSite, id);
    const body = JSON.stringify(result);
    if (result?.episodes?.length) {
      writeJsonCache(
        ctx,
        cacheUrl,
        body,
        DETAIL_EDGE_SECONDS,
        DETAIL_BROWSER_SECONDS
      );
    }

    return new NextResponse(body, {
      headers: {
        ...jsonCacheHeaders(DETAIL_EDGE_SECONDS, DETAIL_BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'MISS',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
