import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getSearchApiSites } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import {
  cacheAgeSeconds,
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { viewerLine } from '@/lib/line';
import { settleWithin } from '@/lib/settle';
import { SearchResult } from '@/lib/types';
import { isAdultContent, isAdultSource } from '@/lib/yellow';

export const runtime = 'edge';

const SEARCH_EDGE_SECONDS = 600;
const SEARCH_BROWSER_SECONDS = 30;
const SEARCH_FRESH_SECONDS = 120;
// 先把 1.5 秒内返回的源交给页面，剩下的源在后台收齐后写入边缘缓存。
const SEARCH_DEADLINE_MS = 1500;

function searchCacheHeaders(state: string) {
  return {
    ...jsonCacheHeaders(SEARCH_EDGE_SECONDS, SEARCH_BROWSER_SECONDS),
    'x-ck-cache': state,
  };
}

function packResults(lists: SearchResult[][], line: string) {
  const results = lists.flatMap((list, index) =>
    list
      .filter((item) => !isAdultContent(item))
      .map((item) => ({
        ...item,
        source_rank: index + 1,
      }))
  );
  return {
    body: JSON.stringify({ results, line }),
    count: results.length,
  };
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
  const query = searchParams.get('q')?.trim() || '';

  if (!query) {
    return NextResponse.json(
      { results: [], line: viewerLine(request) },
      { headers: searchCacheHeaders('EMPTY') }
    );
  }

  const line = viewerLine(request);
  const cacheUrl = `https://cktv-cache.local/search?q=${encodeURIComponent(
    query
  )}&line=${line}&v=5`;

  const refresh = async () => {
    const apiSites = (await getSearchApiSites(line)).filter(
      (site) => !isAdultSource(site)
    );
    const lists = await Promise.all(
      apiSites.map((site) => searchFromApi(site, query))
    );
    const packed = packResults(lists, line);
    if (packed.count > 0) {
      writeJsonCache(
        ctx,
        cacheUrl,
        packed.body,
        SEARCH_EDGE_SECONDS,
        SEARCH_BROWSER_SECONDS
      );
    }
  };

  try {
    const hit = await readJsonCache(cacheUrl);
    if (hit) {
      const age = cacheAgeSeconds(hit);
      const text = await hit.text();
      if (age >= SEARCH_FRESH_SECONDS) {
        ctx?.waitUntil(refresh().catch(() => undefined));
      }
      return new NextResponse(text, {
        headers: searchCacheHeaders(
          age >= SEARCH_FRESH_SECONDS ? 'STALE' : 'HIT'
        ),
      });
    }

    const apiSites = (await getSearchApiSites(line)).filter(
      (site) => !isAdultSource(site)
    );
    const settled = await settleWithin(
      apiSites.map((site) => searchFromApi(site, query)),
      SEARCH_DEADLINE_MS,
      [] as SearchResult[]
    );
    const packed = packResults(settled.values, line);

    if (settled.complete) {
      if (packed.count > 0) {
        writeJsonCache(
          ctx,
          cacheUrl,
          packed.body,
          SEARCH_EDGE_SECONDS,
          SEARCH_BROWSER_SECONDS
        );
      }
    } else if (ctx) {
      ctx.waitUntil(
        settled.done
          .then(() => {
            const full = packResults(settled.values, line);
            if (full.count > 0) {
              writeJsonCache(
                ctx,
                cacheUrl,
                full.body,
                SEARCH_EDGE_SECONDS,
                SEARCH_BROWSER_SECONDS
              );
            }
          })
          .catch(() => undefined)
      );
    } else {
      void settled.done;
    }

    return new NextResponse(packed.body, {
      headers: searchCacheHeaders(settled.complete ? 'MISS' : 'PARTIAL'),
    });
  } catch {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
