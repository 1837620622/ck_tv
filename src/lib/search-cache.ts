// 搜索缓存的版本。客户端地址和边缘缓存键一起用它。
// 改版本会让上一次部署留下的旧列表失效。
export const SEARCH_CACHE_VERSION = '13';

// 详情同样避开上一版钉住的集数。
export const DETAIL_CACHE_VERSION = '7';

export interface ListedHit {
  source?: string;
  id?: string;
  episode_count?: number;
  episodes?: unknown[];
  remarks?: string;
}

// 集数或更新说明变了，就算条数没变，也要换上新结果。
export function listingStamp(items: ListedHit[]): string {
  return items
    .map((item) => {
      const count =
        item.episode_count ||
        (Array.isArray(item.episodes) ? item.episodes.length : 0);
      return `${item.source || ''}:${item.id || ''}:${count}:${
        item.remarks || ''
      }`;
    })
    .join('\n');
}

// 新结果更全，或者同样全但集数变了，才替换当前列表。
// 少回来几条时先留着，避免一个源超时把已经显示的剧盖掉。
export function shouldReplaceListing(
  current: ListedHit[],
  next: ListedHit[]
): boolean {
  if (next.length === 0) return false;
  if (next.length > current.length) return true;
  if (next.length < current.length) return false;
  return listingStamp(next) !== listingStamp(current);
}

interface PackedSearch {
  results?: ListedHit[];
  line?: string;
}

// 答上来的源用新结果整个换掉（集数、更新说明都在里面）。
// 这次没答上的源保留上一次的条目，不因为总条数变少就丢掉整页。
export function mergeSearchBodies(
  previousText: string,
  nextText: string
): string | null {
  let previous: PackedSearch;
  let next: PackedSearch;
  try {
    previous = JSON.parse(previousText) as PackedSearch;
    next = JSON.parse(nextText) as PackedSearch;
  } catch {
    return null;
  }
  const oldResults = Array.isArray(previous.results) ? previous.results : [];
  const newResults = Array.isArray(next.results) ? next.results : [];
  if (newResults.length === 0) return null;
  const answered = new Set(
    newResults
      .map((item) => item.source)
      .filter((source): source is string => !!source)
  );
  const kept = oldResults.filter(
    (item) => item.source && !answered.has(item.source)
  );
  return JSON.stringify({
    results: [...newResults, ...kept],
    line: next.line || previous.line,
  });
}
