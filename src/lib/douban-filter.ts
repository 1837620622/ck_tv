import { DoubanItem } from './types';

// 每页 25 部，筛选时一次取回前 4 页（100 部）在本地过滤
export const FILTER_PAGE_SIZE = 25;
export const FILTER_POOL_PAGES = 4;

export interface DoubanFilter {
  // '' 不限；'2026' 之类的单年；'decade-2010' / 'decade-2000' 年代；'earlier' 2000 年以前
  year: string;
  // '' 不限；'7' 表示 7 分及以上
  minRate: string;
  // '' 综合；'rate' 评分从高到低；'year' 年份从新到旧
  sort: string;
}

export const EMPTY_FILTER: DoubanFilter = { year: '', minRate: '', sort: '' };

export function isFilterActive(filter: DoubanFilter): boolean {
  return Boolean(filter.year || filter.minRate || filter.sort);
}

export interface FilterOption {
  label: string;
  value: string;
}

// 年份选项：全部、当前年到 2020 年逐年、2010 年代、2000 年代、更早
export function yearOptions(currentYear: number): FilterOption[] {
  const years = Array.from(
    { length: Math.max(currentYear - 2019, 0) },
    (_, index) => currentYear - index
  );
  return [
    { label: '全部', value: '' },
    ...years.map((year) => ({ label: String(year), value: String(year) })),
    { label: '2010年代', value: 'decade-2010' },
    { label: '2000年代', value: 'decade-2000' },
    { label: '更早', value: 'earlier' },
  ];
}

export const RATE_OPTIONS: FilterOption[] = [
  { label: '不限', value: '' },
  { label: '7分以上', value: '7' },
  { label: '8分以上', value: '8' },
  { label: '9分以上', value: '9' },
];

export const SORT_OPTIONS: FilterOption[] = [
  { label: '综合', value: '' },
  { label: '评分最高', value: 'rate' },
  { label: '最新上映', value: 'year' },
];

// 年份字段不是四位数字时视为缺失
function parseYear(value: string): number | null {
  return /^\d{4}$/.test(value) ? Number(value) : null;
}

function parseRate(value: string): number | null {
  const rate = Number(value);
  return value !== '' && Number.isFinite(rate) ? rate : null;
}

function yearMatches(year: number, filter: string): boolean {
  if (filter === 'decade-2010') return year >= 2010 && year <= 2019;
  if (filter === 'decade-2000') return year >= 2000 && year <= 2009;
  if (filter === 'earlier') return year < 2000;
  return year === Number(filter);
}

// 缺失值排在最后，其余按降序；Array.prototype.sort 稳定，相同值保持原来的顺序
function sortDescending(
  items: DoubanItem[],
  key: (item: DoubanItem) => number | null
): DoubanItem[] {
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  });
}

// 先去重，再按年份、评分下限过滤，最后排序。没有年份或评分的条目，在对应条件生效时会被排除。
export function filterAndSortDouban(
  items: DoubanItem[],
  filter: DoubanFilter
): DoubanItem[] {
  const seen = new Set<string>();
  let list = items.filter((item) => {
    const key = item.id || item.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (filter.year) {
    list = list.filter((item) => {
      const year = parseYear(item.year);
      return year !== null && yearMatches(year, filter.year);
    });
  }

  if (filter.minRate) {
    const min = Number(filter.minRate);
    list = list.filter((item) => {
      const rate = parseRate(item.rate);
      return rate !== null && rate >= min;
    });
  }

  if (filter.sort === 'rate') {
    list = sortDescending(list, (item) => parseRate(item.rate));
  } else if (filter.sort === 'year') {
    list = sortDescending(list, (item) => parseYear(item.year));
  }

  return list;
}
