import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getSearchApiSites } from '@/lib/config';
import { recentlyFailed, searchFromApi } from '@/lib/downstream';
import {
  cacheAgeSeconds,
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { lineBudget, viewerLine } from '@/lib/line';
import { clientIp, isCrossSite, takeQuota } from '@/lib/request-guard';
import { mergeSearchBodies, SEARCH_CACHE_VERSION } from '@/lib/search-cache';
import { settleWithin } from '@/lib/settle';
import {
  downSourceKeys,
  readSourceWatch,
  scheduleSourceWatch,
  watchBatch,
} from '@/lib/source-watch';
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
    ...jsonCacheHeaders(edgeSeconds, browserSeconds, 0),
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
  void work()
    .catch(() => undefined)
    .finally(() => {
      inflight.delete(cacheUrl);
      resolve();
    });
}

async function writeMerged(
  ctx: Parameters<typeof writeJsonCache>[0],
  cacheUrl: string,
  body: string,
  edgeSeconds: number,
  browserSeconds: number
) {
  const old = await readJsonCache(cacheUrl);
  let next = body;
  if (old) {
    const merged = mergeSearchBodies(await old.text(), body);
    // 新的一轮一个源都没答上时，保留上一次的列表。
    if (!merged) return;
    next = merged;
  }
  await writeJsonCache(ctx, cacheUrl, next, edgeSeconds, browserSeconds, 0);
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

const MAX_QUERY = 60;

export async function GET(request: Request) {
  if (isCrossSite(request)) {
    return NextResponse.json(
      { error: '不允许跨站调用' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const ip = clientIp(request);
  if (ip) {
    const wait = takeQuota(`search:${ip}`, 90, 60_000);
    if (wait > 0) {
      return NextResponse.json(
        { error: '请求太频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(wait) } }
      );
    }
  }

  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() || '';
  if (query.length > MAX_QUERY) {
    return NextResponse.json(
      { error: '关键词太长' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

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
  )}&line=${line}&slim=${slim ? '1' : '0'}&v=${SEARCH_CACHE_VERSION}`;

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
      await writeMerged(
        ctx,
        cacheUrl,
        packed.body,
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
      scheduleSourceWatch(watchBatch(await loadSites()), ctx);
      const text = await hit.text();
      if (age >= budget.freshSeconds) {
        startFill(cacheUrl, refresh);
        const pending = inflight.get(cacheUrl);
        if (pending) ctx?.waitUntil(pending.catch(() => undefined));
        if (pending) {
          await Promise.race([
            pending.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, budget.waitStaleMs)),
          ]);
          const newer = await readJsonCache(cacheUrl);
          if (newer) {
            return new NextResponse(await newer.text(), {
              headers: searchCacheHeaders(
                'FRESH',
                budget.edgeSeconds,
                budget.browserSeconds
              ),
            });
          }
        }
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
    const watch = await readSourceWatch();
    scheduleSourceWatch(watchBatch(apiSites), ctx);
    const down = new Set(downSourceKeys(watch));
    // 最近失败过、以及巡检判定不通的源不占快速名额，改到后台补齐。
    // 快速名额仍按 config.json 的顺序取。
    const healthy = apiSites.filter(
      (site) => !recentlyFailed(site.key) && !down.has(site.key)
    );
    const fastSites = healthy.slice(0, budget.fastCount);
    const fastKeys = new Set(fastSites.map((site) => site.key));
    const restSites = apiSites.filter((site) => !fastKeys.has(site.key));
    const settled = await settleWithin(
      fastSites.map((site) =>
        searchFromApi(site, query, { timeoutMs: budget.timeoutMs })
      ),
      budget.deadlineMs,
      [] as SearchResult[]
    );
    // 结果始终按 config.json 的原始顺序排列，source_rank 不会因为快速名额的变化而改变
    const collect = (
      fastValues: SearchResult[][],
      restValues: SearchResult[][]
    ) => {
      const byKey = new Map<string, SearchResult[]>();
      fastSites.forEach((site, index) =>
        byKey.set(site.key, fastValues[index] || [])
      );
      restSites.forEach((site, index) =>
        byKey.set(site.key, restValues[index] || [])
      );
      return apiSites.map((site) => byKey.get(site.key) || []);
    };
    const packed = packResults(collect(settled.values, []), line, slim);

    const fillCache = () =>
      startFill(cacheUrl, async () => {
        await settled.done;
        const restLists = await Promise.all(
          restSites.map((site) =>
            searchFromApi(site, query, { timeoutMs: budget.timeoutMs })
          )
        );
        const full = packResults(
          collect(settled.values, restLists),
          line,
          slim
        );
        if (full.count > 0) {
          await writeMerged(
            ctx,
            cacheUrl,
            full.body,
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
