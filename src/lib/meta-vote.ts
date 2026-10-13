import { GENRE_NAMES, REGION_NAMES } from './douban-filter';
import { titlesMatch } from './match-title';
import type { SearchResult } from './types';

// 多源核对：豆瓣和每个资源源各自给出年份、地区、题材，按多数表决得到结论。
// 这里只放纯函数，网络请求和缓存在接口层做。

export interface MetaVote {
  source: string;
  year?: string;
  regions?: string[];
  genres?: string[];
}

export interface MetaConsensus {
  year: string;
  regions: string[];
  genres: string[];
  // 给出过年份、地区或题材之一的票数
  voters: number;
}

// 资源站常用的地区写法，映射到豆瓣的标准名
const REGION_ALIASES: Record<string, string> = {
  大陆: '中国大陆',
  内地: '中国大陆',
  香港: '中国香港',
  台湾: '中国台湾',
};

const TOKEN_SPLIT = /[\s,，/、|·;；]+/;

const isYear = (value: string) => /^\d{4}$/.test(value);

// 按已知名称取出现的项，结果保持已知名称的顺序并去重
function pickKnown(
  text: string | undefined,
  known: readonly string[],
  aliases: Record<string, string> = {}
): string[] {
  const found = new Set<string>();
  String(text || '')
    .split(TOKEN_SPLIT)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      const name = aliases[token] ?? token;
      if (known.includes(name)) found.add(name);
    });
  return known.filter((name) => found.has(name));
}

// 资源源的一条结果转成一票
export function resourceVote(result: SearchResult): MetaVote {
  return {
    source: result.source,
    year: isYear(result.year || '') ? result.year : '',
    regions: pickKnown(result.area, REGION_NAMES, REGION_ALIASES),
    genres: pickKnown(result.class, GENRE_NAMES),
  };
}

export function hasMeta(vote: MetaVote): boolean {
  return Boolean(vote.year || vote.regions?.length || vote.genres?.length);
}

// 每个源只取第一条标题匹配的结果，避免同一个源的多条模糊命中被重复计票。
// 标题要按播放端同样的规则匹配（季数、预告分开），年份两边都有且不同时直接排除。
export function firstMatchPerSource(
  results: SearchResult[],
  title: string,
  year: string
): SearchResult[] {
  const seen = new Set<string>();
  const matched: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.source)) continue;
    if (!titlesMatch(result.title, title)) continue;
    const resultYear = isYear(result.year || '') ? result.year : '';
    if (isYear(year) && resultYear && resultYear !== year) continue;
    // 没有任何可用信息的重复条目不占这个源的名额，否则会把同源的完整条目挡在外面
    if (!hasMeta(resourceVote(result))) continue;
    seen.add(result.source);
    matched.push(result);
  }
  return matched;
}

// 多数表决。只统计给出了该字段的票：两票及以上需要过半，只有一票时直接采用。
function majority(lists: string[][], known: readonly string[]): string[] {
  const responders = lists.filter((list) => list.length > 0);
  if (responders.length === 0) return [];
  const threshold =
    responders.length >= 2 ? Math.floor(responders.length / 2) + 1 : 1;
  return known.filter(
    (name) =>
      responders.filter((list) => list.includes(name)).length >= threshold
  );
}

// 年份取票数最多的；票数相同时取先出现的（调用方应把豆瓣放在最前）
export function voteConsensus(votes: MetaVote[]): MetaConsensus {
  const counts = new Map<string, number>();
  votes.forEach((vote) => {
    if (vote.year) counts.set(vote.year, (counts.get(vote.year) || 0) + 1);
  });
  let year = '';
  let best = 0;
  votes.forEach((vote) => {
    if (!vote.year) return;
    const count = counts.get(vote.year) || 0;
    if (count > best) {
      best = count;
      year = vote.year;
    }
  });
  return {
    year,
    regions: majority(
      votes.map((vote) => vote.regions || []),
      REGION_NAMES
    ),
    genres: majority(
      votes.map((vote) => vote.genres || []),
      GENRE_NAMES
    ),
    voters: votes.filter(hasMeta).length,
  };
}
