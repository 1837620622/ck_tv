// 同一部片子有多条线路时怎么选。
// 1. 先看集数：要看的那一集，这条线路得有。采集站更新有先后，有的到第 5 集，有的已经到第 6 集。
// 2. 再看快慢：在有这一集的线路里，从访客自己的浏览器同时去要这一集的播放清单，谁先完整回来就用谁。
//    测的是访客到片源 CDN 的线路，不是服务器的。只拿清单（几 KB），不下载正片。
// 3. 都没回来就按 config.json 的顺序。

import type { SearchResult } from '@/lib/types';

export function episodeCountOf(source: SearchResult): number {
  if (source.episodes?.length) return source.episodes.length;
  return source.episode_count || 0;
}

// 所有线路里最新的一集，按集数最多的那条算
export function latestEpisodeCount(
  sources: SearchResult[],
  current?: SearchResult | null
): number {
  let max = current ? episodeCountOf(current) : 0;
  for (const source of sources) max = Math.max(max, episodeCountOf(source));
  return max;
}

export function sourceKey(source: Pick<SearchResult, 'source' | 'id'>) {
  return `${source.source}:${source.id}`;
}

// 有第 index 集（从 0 起）的线路，按 config.json 顺序排。
export function sourcesWithEpisode(
  sources: SearchResult[],
  index: number,
  exclude: Set<string> = new Set()
): SearchResult[] {
  return sources
    .filter((source) => episodeCountOf(source) > index)
    .filter((source) => !exclude.has(sourceKey(source)))
    .sort((a, b) => (a.source_rank ?? 999) - (b.source_rank ?? 999));
}

type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<{ ok: boolean; text(): Promise<string> }>;

export type PickOptions = {
  // 最多同时测几条，按顺序取前几条
  limit?: number;
  // 总共最多等多久，超时就交给调用方按顺序选
  budgetMs?: number;
  fetchImpl?: FetchLike;
};

function playableUrl(source: SearchResult, index: number): string {
  const url = source.episodes?.[index] || '';
  return /^https?:\/\//i.test(url) ? url : '';
}

// 同时测前几条线路的这一集，返回最先拿到完整清单的那条；都不行返回 null。
export async function pickFastest(
  candidates: SearchResult[],
  index: number,
  options: PickOptions = {}
): Promise<SearchResult | null> {
  const limit = options.limit ?? 4;
  const budgetMs = options.budgetMs ?? 2500;
  const doFetch: FetchLike =
    options.fetchImpl ??
    ((url, init) => fetch(url, init) as ReturnType<FetchLike>);
  const probes = candidates
    .map((source) => ({ source, url: playableUrl(source, index) }))
    .filter((probe) => probe.url)
    .slice(0, limit);
  if (probes.length === 0) return null;
  if (probes.length === 1) return probes[0].source;

  const controller = new AbortController();
  return new Promise<SearchResult | null>((resolve) => {
    let pending = probes.length;
    let done = false;
    const finish = (winner: SearchResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      controller.abort();
      resolve(winner);
    };
    const timer = setTimeout(() => finish(null), budgetMs);
    for (const { source, url } of probes) {
      doFetch(url, { signal: controller.signal, credentials: 'omit' })
        .then(async (response) => {
          if (!response.ok) throw new Error('bad status');
          const text = await response.text();
          if (!text.includes('#EXTM3U')) throw new Error('not a playlist');
          finish(source);
        })
        .catch(() => {
          pending -= 1;
          if (pending === 0) finish(null);
        });
    }
  });
}
