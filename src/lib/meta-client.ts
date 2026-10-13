import type { DoubanFilter } from './douban-filter';
import type { DoubanItem } from './types';

// 页面端的多源核对：只挑出当前筛选条件用得上、但豆瓣没给出的片子，分批交给 /api/meta 核对。

export const META_BATCH_SIZE = 8;
export const META_VERIFY_LIMIT = 40;
const META_CONCURRENCY = 2;
// 服务端最坏约 21 秒：每部每个源 2.5 秒、失败后还会重试一次，8 部分 4 轮处理
const META_TIMEOUT_MS = 30000;

export interface ResourceMeta {
  year: string;
  regions: string[];
  genres: string[];
  resourceVotes: number;
}

const isYear = (value: string) => /^\d{4}$/.test(value);

// 当前筛选用得上、但条目里缺失的信息
export function needsVerification(
  item: DoubanItem,
  filter: DoubanFilter
): boolean {
  if ((filter.year || filter.sort === 'year') && !isYear(item.year)) {
    return true;
  }
  if (filter.region && !item.regions?.length) return true;
  if (filter.genre && !item.genres?.length) return true;
  return false;
}

// 把资源源的核对结果补到豆瓣条目上。只补缺失的字段，豆瓣已有的数据不被覆盖。
export function mergeResourceMeta(
  item: DoubanItem,
  meta: ResourceMeta | undefined
): DoubanItem {
  if (!meta || meta.resourceVotes === 0) return item;
  const next: DoubanItem = { ...item, verified: meta.resourceVotes };
  if (!isYear(item.year) && meta.year) next.year = meta.year;
  if (!item.regions?.length && meta.regions.length) {
    next.regions = meta.regions;
  }
  if (!item.genres?.length && meta.genres.length) {
    next.genres = meta.genres;
  }
  return next;
}

async function verifyBatch(
  batch: DoubanItem[]
): Promise<Record<string, ResourceMeta> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);
  try {
    const response = await fetch('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        items: batch.map((item) => ({
          id: item.id,
          title: item.title,
          year: isYear(item.year) ? item.year : '',
        })),
      }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      results?: Record<string, ResourceMeta>;
      degraded?: boolean;
    };
    // 所有资源源都没有答复：这一批按失败计算，而不是「没有数据」
    if (data.degraded) return null;
    return data.results || {};
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 返回每部片的核对结果，以及失败的批次里共有多少部没有核对成功
export async function fetchResourceMeta(
  items: DoubanItem[]
): Promise<{ results: Map<string, ResourceMeta>; failed: number }> {
  const batches: DoubanItem[][] = [];
  for (let index = 0; index < items.length; index += META_BATCH_SIZE) {
    batches.push(items.slice(index, index + META_BATCH_SIZE));
  }

  const results = new Map<string, ResourceMeta>();
  let failed = 0;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(META_CONCURRENCY, batches.length) },
    async () => {
      while (next < batches.length) {
        const batch = batches[next];
        next += 1;
        const answer = await verifyBatch(batch);
        if (!answer) {
          failed += batch.length;
          continue;
        }
        batch.forEach((item) => {
          const meta = answer[item.id];
          if (meta) results.set(item.id, meta);
        });
      }
    }
  );
  await Promise.all(workers);
  return { results, failed };
}
