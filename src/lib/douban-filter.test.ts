import {
  applyFilterToSearch,
  EMPTY_FILTER,
  filterAndSortDouban,
  filterFromSearch,
  isFilterActive,
  parseCardMeta,
  sameFilter,
  yearOptions,
} from './douban-filter';
import { DoubanItem } from './types';

const item = (
  id: string,
  year: string,
  rate: string,
  meta: { regions?: string[]; genres?: string[] } = {},
  title = `片名${id}`
): DoubanItem => ({
  id,
  title,
  poster: '',
  year,
  rate,
  regions: meta.regions,
  genres: meta.genres,
});

const pool: DoubanItem[] = [
  item('1', '2026', '8.1', { regions: ['中国大陆'], genres: ['剧情'] }),
  item('2', '2024', '9.2', { regions: ['韩国'], genres: ['爱情', '喜剧'] }),
  item('3', '2015', '6.0', { regions: ['中国大陆'], genres: ['悬疑'] }),
  item('4', '2012', ''),
  item('5', '', '8.8', { regions: ['美国'], genres: ['科幻'] }),
  item('6', '1998', '7.5', { regions: ['中国香港'], genres: ['动作'] }),
  item('7', '2025', '7.0', { regions: ['日本'], genres: ['剧情'] }),
];

describe('filterAndSortDouban', () => {
  it('keeps the original order when no filter is set', () => {
    expect(filterAndSortDouban(pool, EMPTY_FILTER).map((i) => i.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
  });

  it('removes duplicate ids, keeping the first one', () => {
    const dup = [
      item('1', '2026', '8.1', {}, 'A'),
      item('1', '2026', '8.1', {}, 'B'),
    ];
    const result = filterAndSortDouban(dup, EMPTY_FILTER);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('A');
  });

  it('filters by a single year and drops items without a year', () => {
    const result = filterAndSortDouban(pool, { ...EMPTY_FILTER, year: '2024' });
    expect(result.map((i) => i.id)).toEqual(['2']);
  });

  it('filters by decade and by "earlier"', () => {
    const tens = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      year: 'decade-2010',
    });
    expect(tens.map((i) => i.id)).toEqual(['3', '4']);

    const earlier = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      year: 'earlier',
    });
    expect(earlier.map((i) => i.id)).toEqual(['6']);
  });

  it('filters by region and drops items without region data', () => {
    const result = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      region: '中国大陆',
    });
    expect(result.map((i) => i.id)).toEqual(['1', '3']);
  });

  it('filters by genre and drops items without genre data', () => {
    const result = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      genre: '剧情',
    });
    expect(result.map((i) => i.id)).toEqual(['1', '7']);
  });

  it('keeps items at or above the minimum rate and drops unrated items', () => {
    const result = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      minRate: '8',
    });
    expect(result.map((i) => i.id)).toEqual(['1', '2', '5']);
  });

  it('sorts by rate descending with unrated items last', () => {
    const result = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      sort: 'rate',
    });
    expect(result.map((i) => i.id)).toEqual([
      '2',
      '5',
      '1',
      '6',
      '7',
      '3',
      '4',
    ]);
  });

  it('sorts by year descending with undated items last', () => {
    const result = filterAndSortDouban(pool, {
      ...EMPTY_FILTER,
      sort: 'year',
    });
    expect(result.map((i) => i.id)).toEqual([
      '1',
      '7',
      '2',
      '3',
      '4',
      '6',
      '5',
    ]);
  });

  it('combines year, region, genre, rate and sort', () => {
    const result = filterAndSortDouban(pool, {
      year: 'decade-2010',
      region: '中国大陆',
      genre: '悬疑',
      minRate: '6',
      sort: 'rate',
    });
    expect(result.map((i) => i.id)).toEqual(['3']);
  });
});

describe('parseCardMeta', () => {
  it('reads the year, region and genres from a subtitle with slashes', () => {
    expect(parseCardMeta('2024 / 中国大陆 / 剧情 悬疑 / 张三 李四')).toEqual({
      year: '2024',
      regions: ['中国大陆'],
      genres: ['剧情', '悬疑'],
    });
  });

  it('matches known names with any separator', () => {
    const meta = parseCardMeta('2019·美国·科幻，喜剧');
    expect(meta.year).toBe('2019');
    expect(meta.regions).toEqual(['美国']);
    expect(meta.genres).toEqual(['科幻', '喜剧']);
  });

  it('returns empty lists when the subtitle has no known names', () => {
    expect(parseCardMeta('')).toEqual({ year: '', regions: [], genres: [] });
    expect(parseCardMeta('未知地区 未知类型')).toEqual({
      year: '',
      regions: [],
      genres: [],
    });
  });
});

describe('filter helpers', () => {
  it('detects whether any filter is active, including region and genre', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, sort: 'rate' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, region: '韩国' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, genre: '剧情' })).toBe(true);
  });

  it('builds year options from the current year down to 2020, then decades', () => {
    const values = yearOptions(2026).map((o) => o.value);
    expect(values).toEqual([
      '',
      '2026',
      '2025',
      '2024',
      '2023',
      '2022',
      '2021',
      '2020',
      'decade-2010',
      'decade-2000',
      'earlier',
    ]);
  });
});

describe('filter and URL round trip', () => {
  it('reads a filter from the query string and ignores unknown values', () => {
    const filter = filterFromSearch(
      new URLSearchParams(
        'type=tv&year=2024&region=韩国&genre=剧情&rate=8&sort=rate'
      )
    );
    expect(filter).toEqual({
      year: '2024',
      region: '韩国',
      genre: '剧情',
      minRate: '8',
      sort: 'rate',
    });
    const bogus = filterFromSearch(
      new URLSearchParams('year=abc&region=火星&genre=x&rate=5&sort=hot')
    );
    expect(bogus).toEqual(EMPTY_FILTER);
  });

  it('writes the filter back and keeps the other parameters', () => {
    const params = applyFilterToSearch(
      new URLSearchParams('type=tv&sub=tv_domestic&region=美国'),
      { ...EMPTY_FILTER, year: 'decade-2010', sort: 'year' }
    );
    expect(params.get('type')).toBe('tv');
    expect(params.get('sub')).toBe('tv_domestic');
    expect(params.get('year')).toBe('decade-2010');
    expect(params.get('sort')).toBe('year');
    expect(params.has('region')).toBe(false);
  });

  it('compares two filters field by field', () => {
    expect(sameFilter(EMPTY_FILTER, { ...EMPTY_FILTER })).toBe(true);
    expect(sameFilter(EMPTY_FILTER, { ...EMPTY_FILTER, genre: '剧情' })).toBe(
      false
    );
  });
});
