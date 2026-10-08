import { SearchResult } from '@/lib/types';

// 片库片名常多空格、标点，或把年份直接接在后面。解说、番外不会因此被当成正片。
export function compactTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[：:·・,，.。!！?？'"“”‘’]/g, '');
}

function coreTitle(raw: string): string {
  return compactTitle(raw).replace(
    /第[0-9一二三四五六七八九十百]+[季部期]/g,
    ''
  );
}

export function titlesMatch(
  resultTitle: string,
  wanted: string,
  year: string
): boolean {
  const result = coreTitle(resultTitle);
  const query = coreTitle(wanted);
  if (!result || !query) return false;
  if (result === query) return true;
  if (/^\d{4}$/.test(year) && result === `${query}${year}`) return true;
  const short = result.length <= query.length ? result : query;
  const long = short === result ? query : result;
  return short.length >= 4 && long.startsWith(short);
}

function episodeCount(item: SearchResult): number {
  if (item.episodes?.length) return item.episodes.length;
  return item.episode_count || 0;
}

// 年份和电影/剧集只用来优先，不能把仅有的正片过滤成空列表。
export function pickPlayable(
  results: SearchResult[],
  title: string,
  year: string,
  searchType: string
): SearchResult[] {
  const titled = results.filter(
    (item) => episodeCount(item) > 0 && titlesMatch(item.title, title, year)
  );
  const yearKnown = /^\d{4}$/.test(year);
  const sameYear = yearKnown
    ? titled.filter(
        (item) => !item.year || item.year === 'unknown' || item.year === year
      )
    : titled;
  const pool = sameYear.length > 0 ? sameYear : titled;
  if (searchType !== 'movie' && searchType !== 'tv') return pool;

  const typed = pool.filter((item) => {
    const count = episodeCount(item);
    if (searchType === 'movie') return count > 0 && count <= 3;
    return count > 1;
  });
  return typed.length > 0 ? typed : pool;
}
