import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextRequest, NextResponse } from 'next/server';

import { getSearchApiSites } from '@/lib/config';
import { recentlyFailed, searchFromApi } from '@/lib/downstream';
import { readJsonCache, writeJsonCache } from '@/lib/edge-cache';
import {
  firstMatchPerSource,
  hasMeta,
  MetaVote,
  resourceVote,
  voteConsensus,
} from '@/lib/meta-vote';

export const runtime = 'edge';

// 每次最多核对 8 部，每部最多问 3 个资源源，同时只处理 2 部。
// Cloudflare 对单个请求的子请求数和同时连接数有限制，所以这里压得比较紧。
const MAX_ITEMS = 8;
const SOURCES_PER_TITLE = 3;
const ITEM_CONCURRENCY = 2;
const SOURCE_TIMEOUT_MS = 2500;
const HIT_EDGE_SECONDS = 86400;
const HIT_BROWSER_SECONDS = 3600;
const EMPTY_EDGE_SECONDS = 900;
const EMPTY_BROWSER_SECONDS = 300;

interface MetaRequestItem {
  id: string;
  title: string;
  year: string;
}

function parseItems(body: unknown): MetaRequestItem[] | null {
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) {
    return null;
  }
  const items: MetaRequestItem[] = [];
  for (const entry of raw) {
    const item = (entry || {}) as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const year = typeof item.year === 'string' ? item.year.trim() : '';
    if (!id || id.length > 64 || !title || title.length > 80) return null;
    items.push({ id, title, year: /^\d{4}$/.test(year) ? year : '' });
  }
  return items;
}

// 只取资源源的票（缓存的也是这部分），豆瓣那一票由调用方在页面上处理
async function resourceVotesFor(
  ctx: ReturnType<typeof getCtx>,
  item: MetaRequestItem,
  sources: Awaited<ReturnType<typeof getSearchApiSites>>
): Promise<MetaVote[]> {
  const cacheUrl = `https://cktv-cache.local/meta-vote?title=${encodeURIComponent(
    item.title
  )}&year=${item.year}&src=${sources.map((site) => site.key).join(',')}&v=1`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    try {
      return (await hit.json()) as MetaVote[];
    } catch {
      // 缓存损坏就当没有命中，重新核对
    }
  }

  const perSource = await Promise.all(
    sources.map((site) =>
      searchFromApi(site, item.title, { timeoutMs: SOURCE_TIMEOUT_MS }).catch(
        () => []
      )
    )
  );
  const votes = firstMatchPerSource(perSource.flat(), item.title, item.year)
    .map(resourceVote)
    .filter(hasMeta);

  writeJsonCache(
    ctx,
    cacheUrl,
    JSON.stringify(votes),
    votes.length > 0 ? HIT_EDGE_SECONDS : EMPTY_EDGE_SECONDS,
    votes.length > 0 ? HIT_BROWSER_SECONDS : EMPTY_BROWSER_SECONDS
  );
  return votes;
}

function getCtx() {
  try {
    return getOptionalRequestContext()?.ctx;
  } catch {
    return undefined;
  }
}

// 限制并发地处理一批任务，保证返回顺序与输入一致
async function mapLimit<T, R>(
  list: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(list.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, list.length) },
    async () => {
      while (next < list.length) {
        const index = next;
        next += 1;
        results[index] = await task(list[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求格式不正确' }, { status: 400 });
  }
  const items = parseItems(body);
  if (!items) {
    return NextResponse.json(
      { error: `items 需要 1 到 ${MAX_ITEMS} 部，且标题不能为空` },
      { status: 400 }
    );
  }

  try {
    const sites = (await getSearchApiSites('cn'))
      .filter((site) => !recentlyFailed(site.key))
      .slice(0, SOURCES_PER_TITLE);
    const ctx = getCtx();

    const votes = await mapLimit(items, ITEM_CONCURRENCY, (item) =>
      resourceVotesFor(ctx, item, sites).catch(() => [] as MetaVote[])
    );

    const results: Record<
      string,
      {
        year: string;
        regions: string[];
        genres: string[];
        resourceVotes: number;
      }
    > = {};
    items.forEach((item, index) => {
      const consensus = voteConsensus(votes[index]);
      results[item.id] = {
        year: consensus.year,
        regions: consensus.regions,
        genres: consensus.genres,
        resourceVotes: votes[index].length,
      };
    });

    return NextResponse.json(
      { results, sources: sites.length },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: '核对失败，请稍后再试' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
