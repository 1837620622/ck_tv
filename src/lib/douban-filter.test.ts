import {
  EMPTY_FILTER,
  filterAndSortDouban,
  isFilterActive,
  yearOptions,
} from './douban-filter';
import { DoubanItem } from './types';

const item = (
  id: string,
  year: string,
  rate: string,
  title = `片名${id}`
): DoubanItem => ({ id, title, poster: '', year, rate });

const pool: DoubanItem[] = [
  item('1', '2026', '8.1'),
  item('2', '2024', '9.2'),
  item('3', '2015', '6.0'),
  item('4', '2012', ''),
  item('5', '', '8.8'),
  item('6', '1998', '7.5'),
  item('7', '2025', '7.0'),
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
    const dup = [item('1', '2026', '8.1', 'A'), item('1', '2026', '8.1', 'B')];
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

  it('combines year, rate and sort', () => {
    const result = filterAndSortDouban(pool, {
      year: 'decade-2010',
      minRate: '6',
      sort: 'rate',
    });
    expect(result.map((i) => i.id)).toEqual(['3']);
  });
});

describe('filter helpers', () => {
  it('detects whether any filter is active', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, sort: 'rate' })).toBe(true);
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
