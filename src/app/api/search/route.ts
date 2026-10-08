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

const inflight = new Map<string, Promise<void>>();

function searchCacheHeaders(
  state: string,
  edgeSeconds: number,
  browserSeconds: number
) {
  if (state === 'PARTIAL') {
    return {
      'Cache-Control': 'private, no-store',
      'CDN-Cache-Control': 'no-store',
      'x-ck-cache': state,
    };
  }
  return {
    ...jsonCacheHeaders(edgeSeconds, browserSeconds),
    'x-ck-cache': state,
  };
}

function startFill(cacheUrl: string, work: () => Promise<void>) {
  if (inflight.has(cacheUrl)) return;
  let resolve: () => void;
  const task = new Promise<void>((done) => {
    resolve = done;
  });
  inflight.set(cacheUrl, task);
  void work().finally(() => {
    inflight.delete(cacheUrl);
    resolve();
  });
}

async function writeIfRicher(
  ctx: Parameters<typeof writeJsonCache>[0],
  cacheUrl: string,
  body: string,
  count: number,
  edgeSeconds: number,
  browserSeconds: number
) {
  const old = await readJsonCache(cacheUrl);
  if (old) {
    try {
      const previous = JSON.parse(await old.text()) as {
        results?: unknown[];
      };
      if ((previous.results?.length || 0) > count) return;
    } catch {
      // 旧缓存解析失败时用新结果覆盖。
    }
  }
  writeJsonCache(ctx, cacheUrl, body, edgeSeconds, browserSeconds);
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
  )}&line=${line}&slim=${slim ? '1' : '0'}&v=10`;

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
      await writeIfRicher(
        ctx,
        cacheUrl,
        packed.body,
        packed.count,
        budget.edgeSeconds,
        budget.browserSeconds
      );
    }
  };

  try {
    const waitInflight = async () => {
      const pending = inflight.get(cacheUrl);
      if (!pending) return null;
      await Promise.race([
        pending.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2600)),
      ]);
      return readJsonCache(cacheUrl);
    };

    const hit = (await readJsonCache(cacheUrl)) || (await waitInflight());
    if (hit) {
      const age = cacheAgeSeconds(hit);
      const text = await hit.text();
      if (age >= budget.freshSeconds) {
        startFill(cacheUrl, refresh);
        const pending = inflight.get(cacheUrl);
        if (pending) ctx?.waitUntil(pending.catch(() => undefined));
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

    const fillCache = () =>
      startFill(cacheUrl, async () => {
        await settled.done;
        const restLists = await Promise.all(
          restSites.map((site) =>
            searchFromApi(site, query, { timeoutMs: budget.timeoutMs })
          )
        );
        const full = packResults([...settled.values, ...restLists], line, slim);
        if (full.count > 0) {
          await writeIfRicher(
            ctx,
            cacheUrl,
            full.body,
            full.count,
            budget.edgeSeconds,
            budget.browserSeconds
          );
        }
      });

    fillCache();
    const pending = inflight.get(cacheUrl);
    if (ctx && pending) ctx.waitUntil(pending.catch(() => undefined));

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
