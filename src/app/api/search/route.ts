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
import { lineBudget, viewerLine } from '@/lib/line';
import { settleWithin } from '@/lib/settle';
import { SearchResult } from '@/lib/types';
import { isAdultContent, isAdultSource } from '@/lib/yellow';

export const runtime = 'edge';

function searchCacheHeaders(
  state: string,
  edgeSeconds: number,
  browserSeconds: number
) {
  return {
    ...jsonCacheHeaders(edgeSeconds, browserSeconds),
    'x-ck-cache': state,
  };
}

function packResults(lists: SearchResult[][], line: string, slim: boolean) {
  const results = lists.flatMap((list, index) =>
    list
      .filter((item) => !isAdultContent(item))
      .map((item) => ({
        ...item,
        episode_count: item.episodes?.length || 0,
        // 列表页不带播放地址。地址是响应体的大头，留给播放页和详情接口。
        episodes: slim ? [] : item.episodes,
        desc: slim ? (item.desc || '').slice(0, 80) : item.desc,
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

  const line = viewerLine(request);
  const budget = lineBudget(line);

  if (!query) {
    return NextResponse.json(
      { results: [], line },
      {
        headers: searchCacheHeaders(
          'EMPTY',
          budget.edgeSeconds,
          budget.browserSeconds
        ),
      }
    );
  }

  const slim = searchParams.get('slim') === '1';
  const cacheUrl = `https://cktv-cache.local/search?q=${encodeURIComponent(
    query
  )}&line=${line}&slim=${slim ? '1' : '0'}&v=8`;

  const loadSites = async () =>
    (await getSearchApiSites(line)).filter((site) => !isAdultSource(site));

  const refresh = async () => {
    const apiSites = await loadSites();
    const lists = await Promise.all(
      apiSites.map((site) =>
        searchFromApi(site, query, { timeoutMs: budget.timeoutMs })
      )
    );
    const packed = packResults(lists, line, slim);
    if (packed.count > 0) {
      writeJsonCache(
        ctx,
        cacheUrl,
        packed.body,
        budget.edgeSeconds,
        budget.browserSeconds
      );
    }
  };

  try {
    const hit = await readJsonCache(cacheUrl);
    if (hit) {
      const age = cacheAgeSeconds(hit);
      const text = await hit.text();
      if (age >= budget.freshSeconds) {
        ctx?.waitUntil(refresh().catch(() => undefined));
      }
      return new NextResponse(text, {
        headers: searchCacheHeaders(
          age >= budget.freshSeconds ? 'STALE' : 'HIT',
          budget.edgeSeconds,
          budget.browserSeconds
        ),
      });
    }

    const apiSites = await loadSites();
    const fastSites = apiSites.slice(0, budget.fastCount);
    const restSites = apiSites.slice(budget.fastCount);
    const settled = await settleWithin(
      fastSites.map((site) =>
        searchFromApi(site, query, { timeoutMs: budget.timeoutMs })
      ),
      budget.deadlineMs,
      [] as SearchResult[]
    );
    const packed = packResults(settled.values, line, slim);

    const fillCache = async () => {
      await settled.done;
      const restLists = await Promise.all(
        restSites.map((site) =>
          searchFromApi(site, query, { timeoutMs: budget.timeoutMs })
        )
      );
      const full = packResults([...settled.values, ...restLists], line, slim);
      if (full.count > 0) {
        writeJsonCache(
          ctx,
          cacheUrl,
          full.body,
          budget.edgeSeconds,
          budget.browserSeconds
        );
      }
    };

    if (ctx) {
      ctx.waitUntil(fillCache().catch(() => undefined));
    } else {
      void fillCache();
    }

    return new NextResponse(packed.body, {
      headers: searchCacheHeaders(
        settled.complete && restSites.length === 0 ? 'MISS' : 'PARTIAL',
        budget.edgeSeconds,
        budget.browserSeconds
      ),
    });
  } catch {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
