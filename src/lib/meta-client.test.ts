import { EMPTY_FILTER } from './douban-filter';
import {
  fetchResourceMeta,
  mergeResourceMeta,
  META_BATCH_SIZE,
  needsVerification,
} from './meta-client';
import type { DoubanItem } from './types';

const item = (id: string, extra: Partial<DoubanItem> = {}): DoubanItem => ({
  id,
  title: `片${id}`,
  poster: '',
  rate: '8.0',
  year: '',
  ...extra,
});

describe('needsVerification', () => {
  it('asks for a check only when the active filter needs a missing field', () => {
    const bare = item('1');
    expect(needsVerification(bare, EMPTY_FILTER)).toBe(false);
    expect(needsVerification(bare, { ...EMPTY_FILTER, year: '2024' })).toBe(
      true
    );
    expect(needsVerification(bare, { ...EMPTY_FILTER, sort: 'year' })).toBe(
      true
    );
    expect(needsVerification(bare, { ...EMPTY_FILTER, region: '韩国' })).toBe(
      true
    );
    expect(needsVerification(bare, { ...EMPTY_FILTER, genre: '剧情' })).toBe(
      true
    );
    // 豆瓣已经有的字段不再核对
    const full = item('2', {
      year: '2024',
      regions: ['韩国'],
      genres: ['剧情'],
    });
    expect(
      needsVerification(full, {
        ...EMPTY_FILTER,
        year: '2024',
        region: '韩国',
        genre: '剧情',
      })
    ).toBe(false);
  });
});

describe('mergeResourceMeta', () => {
  it('fills only the missing fields and records the number of votes', () => {
    const merged = mergeResourceMeta(item('1', { regions: ['韩国'] }), {
      year: '2024',
      regions: ['中国大陆'],
      genres: ['剧情'],
      resourceVotes: 2,
    });
    expect(merged.year).toBe('2024');
    expect(merged.regions).toEqual(['韩国']);
    expect(merged.genres).toEqual(['剧情']);
    expect(merged.verified).toBe(2);
  });

  it('returns the item unchanged when no source voted', () => {
    const original = item('1');
    expect(
      mergeResourceMeta(original, {
        year: '',
        regions: [],
        genres: [],
        resourceVotes: 0,
      })
    ).toBe(original);
    expect(mergeResourceMeta(original, undefined)).toBe(original);
  });
});

describe('fetchResourceMeta', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('splits the items into batches and merges the answers by id', async () => {
    const items = Array.from({ length: META_BATCH_SIZE * 2 + 1 }, (_, i) =>
      item(String(i))
    );
    const bodies: { items: { id: string }[] }[] = [];
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const results: Record<string, unknown> = {};
      body.items.forEach((entry: { id: string }) => {
        results[entry.id] = {
          year: '2024',
          regions: ['韩国'],
          genres: [],
          resourceVotes: 1,
        };
      });
      return { ok: true, json: async () => ({ results }) } as Response;
    }) as unknown as typeof fetch;

    const { results, failed } = await fetchResourceMeta(items);
    expect(bodies.map((b) => b.items.length)).toEqual([8, 8, 1]);
    expect(results.size).toBe(items.length);
    expect(failed).toBe(0);
    expect(results.get('16')?.year).toBe('2024');
  });

  it('counts a failed batch instead of throwing', async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(String(i)));
    let call = 0;
    global.fetch = jest.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: false, status: 500 } as Response;
      }
      return {
        ok: true,
        json: async () => ({ results: {} }),
      } as Response;
    }) as unknown as typeof fetch;

    const { failed } = await fetchResourceMeta(items);
    expect(failed).toBe(META_BATCH_SIZE);
  });
});
