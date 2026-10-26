import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextRequest, NextResponse } from 'next/server';

import { DEFAULT_JSON_BODY_BYTES, readJsonBody } from '@/lib/body';
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
import { isCrossSite } from '@/lib/request-guard';
import type { SearchResult } from '@/lib/types';

export const runtime = 'edge';

// 每次最多核对 8 部，每部最多问 3 个资源源，同时只处理 2 部。
// Cloudflare 对单个请求的子请求数和同时连接数有限制，所以这里压得比较紧。
const MAX_ITEMS = 8;
const MAX_TITLE_LENGTH = 200;
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
    if (!id || id.length > 64 || !title || title.length > MAX_TITLE_LENGTH) {
      return null;
    }
    items.push({ id, title, year: /^\d{4}$/.test(year) ? year : '' });
  }
  return items;
}

interface Lookup {
  // 只取资源源的票（缓存的也是这部分），豆瓣那一票由调用方在页面上处理
  votes: MetaVote[];
  // 这次实际去问了、但超时或出错的源数；命中缓存时为 0
  failures: number;
  sources: number;
}

async function resourceVotesFor(
  ctx: ReturnType<typeof getCtx>,
  item: MetaRequestItem,
  sources: Awaited<ReturnType<typeof getSearchApiSites>>
): Promise<Lookup> {
  if (sources.length === 0) return { votes: [], failures: 0, sources: 0 };

  const cacheUrl = `https://cktv-cache.local/meta-vote?title=${encodeURIComponent(
    item.title
  )}&year=${item.year}&src=${sources.map((site) => site.key).join(',')}&v=1`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    try {
      const votes = (await hit.json()) as MetaVote[];
      return { votes, failures: 0, sources: sources.length };
    } catch {
      // 缓存损坏就当没有命中，重新核对
    }
  }

  let failures = 0;
  const perSource = await Promise.all(
    sources.map((site) =>
      searchFromApi(site, item.title, {
        timeoutMs: SOURCE_TIMEOUT_MS,
        onFailure: () => {
          failures += 1;
        },
      }).catch((): SearchResult[] => {
        failures += 1;
        return [];
      })
    )
  );
  const votes = firstMatchPerSource(perSource.flat(), item.title, item.year)
    .map(resourceVote)
    .filter(hasMeta);

  // 有源超时或出错时结果不完整：不缓存，下次再核对。否则一次超时会被当成「没有匹配」存一整天
  if (failures === 0) {
    writeJsonCache(
      ctx,
      cacheUrl,
      JSON.stringify(votes),
      votes.length > 0 ? HIT_EDGE_SECONDS : EMPTY_EDGE_SECONDS,
      votes.length > 0 ? HIT_BROWSER_SECONDS : EMPTY_BROWSER_SECONDS
    );
  }
  return { votes, failures, sources: sources.length };
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
  // 每次请求都会去查好几个采集站，不让别的网站借访客的浏览器来调用
  if (isCrossSite(request)) {
    return NextResponse.json(
      { error: '不允许跨站调用' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  // 请求体边读边计数，超过上限就不再读，避免单个请求把任意大小的内容整个读进内存
  const read = await readJsonBody(request, DEFAULT_JSON_BODY_BYTES);
  if (!read.ok) {
    return NextResponse.json({ error: read.error }, { status: read.status });
  }
  const items = parseItems(read.data);
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

    const lookups = await mapLimit(items, ITEM_CONCURRENCY, (item) =>
      resourceVotesFor(ctx, item, sites).catch(
        (): Lookup => ({
          votes: [],
          failures: sites.length,
          sources: sites.length,
        })
      )
    );

    // 没有任何源答复（或根本没有可用的源）时，这一批等于没有核对成功。
    // 明确告诉页面，页面会显示「核对失败」，而不是把它当成「没有数据」
    const degraded = lookups.every(
      (lookup) => lookup.sources === 0 || lookup.failures === lookup.sources
    );
    if (degraded) {
      return NextResponse.json(
        { results: {}, sources: sites.length, degraded: true },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

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
      const { votes, failures, sources } = lookups[index];
      // 这一部的源全部超时或出错：不返回结果，页面把它算作核对失败，而不是「没有数据」
      if (sources > 0 && failures === sources) return;
      const consensus = voteConsensus(votes);
      results[item.id] = {
        year: consensus.year,
        regions: consensus.regions,
        genres: consensus.genres,
        resourceVotes: votes.length,
      };
    });

    return NextResponse.json(
      { results, sources: sites.length, degraded: false },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json(
      { error: '核对失败，请稍后再试' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
