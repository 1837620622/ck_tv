// 同一部片子在不同线路上看过，会留下好几条播放记录（键是「线路+编号」）。
// 「继续观看」里一部片子只显示一张卡：取最近看的那条，集数取这几条里最新的。
// 片名按 titleParts 归一（去空格、标点），「DoctorX：白色黑手党」和「Doctor X：白色黑手党」是同一部。
// 年份都有且不同时算两部；有一条没有年份时并在一起。

import { workKey } from '@/lib/match-title';

export type RecordLike = {
  title: string;
  year: string;
  total_episodes: number;
  save_time: number;
};

export type RecordGroup<T extends RecordLike> = {
  // 最近看的那一条，卡片按它显示和跳转
  latest: T & { key: string };
  // 这部片子的全部记录键，删除时一起删
  keys: string[];
  // 各线路里最新的一集
  totalEpisodes: number;
};

function yearOf(record: RecordLike): string {
  return /^\d{4}$/.test(record.year || '') ? record.year : '';
}

export function groupPlayRecords<T extends RecordLike>(
  records: Record<string, T>
): RecordGroup<T>[] {
  const buckets = new Map<
    string,
    Array<{ year: string; items: Array<T & { key: string }> }>
  >();
  for (const [key, record] of Object.entries(records)) {
    const base = workKey(record.title || '', '', record.total_episodes || 1);
    const year = yearOf(record);
    const bucket = buckets.get(base) || [];
    let group = bucket.find(
      (candidate) => !candidate.year || !year || candidate.year === year
    );
    if (!group) {
      group = { year, items: [] };
      bucket.push(group);
    }
    if (!group.year) group.year = year;
    group.items.push({ ...record, key });
    buckets.set(base, bucket);
  }

  const groups: RecordGroup<T>[] = [];
  buckets.forEach((bucket) => {
    for (const { items } of bucket) {
      const sorted = [...items].sort((a, b) => b.save_time - a.save_time);
      groups.push({
        latest: sorted[0],
        keys: sorted.map((item) => item.key),
        totalEpisodes: Math.max(
          ...sorted.map((item) => item.total_episodes || 0)
        ),
      });
    }
  });
  return groups.sort((a, b) => b.latest.save_time - a.latest.save_time);
}

// 和 key 是同一部片子的其它记录键，用来删旧线路的记录。
// 删除比合并显示更保守：年份必须一样（都写了且相同，或都没写），
// 一条有年份、一条没有时不删，避免把同名翻拍的进度删掉。
export function siblingKeys<T extends RecordLike>(
  records: Record<string, T>,
  key: string
): string[] {
  const self = records[key];
  if (!self) return [];
  const group = groupPlayRecords(records).find((g) => g.keys.includes(key));
  if (!group) return [];
  return group.keys.filter(
    (k) => k !== key && yearOf(records[k]) === yearOf(self)
  );
}

export function splitRecordKey(key: string): { source: string; id: string } {
  const plus = key.indexOf('+');
  return plus < 0
    ? { source: key, id: '' }
    : { source: key.slice(0, plus), id: key.slice(plus + 1) };
}
