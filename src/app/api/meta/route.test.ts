jest.mock(
  '@cloudflare/next-on-pages',
  () => ({ getOptionalRequestContext: () => undefined }),
  { virtual: true }
);
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock('@/lib/config', () => ({
  getSearchApiSites: jest.fn(async () => [
    { key: 's1', name: 'S1', api: 'https://s1.invalid' },
    { key: 's2', name: 'S2', api: 'https://s2.invalid' },
    { key: 's3', name: 'S3', api: 'https://s3.invalid' },
    { key: 's4', name: 'S4', api: 'https://s4.invalid' },
  ]),
}));
jest.mock('@/lib/downstream', () => ({
  recentlyFailed: jest.fn(() => false),
  searchFromApi: jest.fn(),
}));
jest.mock('@/lib/edge-cache', () => ({
  readJsonCache: jest.fn(async () => null),
  writeJsonCache: jest.fn(),
}));

import { getSearchApiSites } from '@/lib/config';
import { recentlyFailed, searchFromApi } from '@/lib/downstream';
import { readJsonCache, writeJsonCache } from '@/lib/edge-cache';
import type { SearchResult } from '@/lib/types';

import { POST } from './route';

const hit = (source: string, extra: Partial<SearchResult>): SearchResult =>
  ({
    id: `${source}-1`,
    title: '功夫女足',
    poster: '',
    episodes: ['https://x.invalid/1.m3u8'],
    source,
    source_name: source,
    year: '2024',
    ...extra,
  } as SearchResult);

const call = (body: unknown) =>
  POST({ json: async () => body } as never) as Promise<{
    status: number;
    json: () => Promise<Record<string, unknown>>;
  }>;

describe('POST /api/meta', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (recentlyFailed as jest.Mock).mockReturnValue(false);
    (readJsonCache as jest.Mock).mockResolvedValue(null);
    (searchFromApi as jest.Mock).mockImplementation(
      async (site: { key: string }, title: string) => {
        if (title === '无关片') return [];
        if (site.key === 's1')
          return [hit('s1', { area: '韩国', class: '剧情' })];
        if (site.key === 's2')
          return [hit('s2', { area: '韩国', class: '剧情' })];
        if (site.key === 's3')
          return [hit('s3', { area: '韩国', year: '2019' })];
        return [];
      }
    );
  });

  it('rejects a body with no items or a blank title', async () => {
    expect((await call({})).status).toBe(400);
    expect((await call({ items: [] })).status).toBe(400);
    expect((await call({ items: [{ id: '1', title: '  ' }] })).status).toBe(
      400
    );
  });

  it('checks the top sources and returns the agreed meta per item', async () => {
    const res = await call({
      items: [
        { id: '1', title: '功夫女足', year: '2024' },
        { id: '2', title: '无关片', year: '' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Record<
        string,
        {
          year: string;
          regions: string[];
          genres: string[];
          resourceVotes: number;
        }
      >;
      sources: number;
    };
    expect(body.sources).toBe(3);
    expect(body.results['1']).toEqual({
      year: '2024',
      regions: ['韩国'],
      genres: ['剧情'],
      resourceVotes: 2,
    });
    expect(body.results['2']).toEqual({
      year: '',
      regions: [],
      genres: [],
      resourceVotes: 0,
    });
    expect(searchFromApi).toHaveBeenCalledTimes(6);
  });

  it('skips sources that failed recently', async () => {
    (recentlyFailed as jest.Mock).mockImplementation(
      (key: string) => key === 's1'
    );
    await call({ items: [{ id: '1', title: '功夫女足', year: '2024' }] });
    const keys = (searchFromApi as jest.Mock).mock.calls.map(
      (args) => (args[0] as { key: string }).key
    );
    expect(keys).not.toContain('s1');
    expect(getSearchApiSites).toHaveBeenCalledWith('cn');
  });

  it('uses the cached votes without asking the sources again', async () => {
    (readJsonCache as jest.Mock).mockResolvedValue({
      json: async () => [
        { source: 's1', year: '2024', regions: ['韩国'], genres: [] },
        { source: 's2', year: '2024', regions: ['韩国'], genres: [] },
      ],
    });
    const res = await call({
      items: [{ id: '1', title: '功夫女足', year: '2024' }],
    });
    const body = (await res.json()) as {
      results: Record<string, { regions: string[] }>;
    };
    expect(body.results['1'].regions).toEqual(['韩国']);
    expect(searchFromApi).not.toHaveBeenCalled();
  });

  it('caches hits for a day and misses for fifteen minutes', async () => {
    await call({
      items: [
        { id: '1', title: '功夫女足', year: '2024' },
        { id: '2', title: '无关片', year: '' },
      ],
    });
    const ttls = (writeJsonCache as jest.Mock).mock.calls.map(
      (args) => args[3]
    );
    expect(ttls).toContain(86400);
    expect(ttls).toContain(900);
  });

  it('reports the batch as degraded when every source failed', async () => {
    (searchFromApi as jest.Mock).mockImplementation(
      async (
        _site: unknown,
        _title: string,
        options: { onFailure: () => void }
      ) => {
        options.onFailure();
        return [];
      }
    );
    const res = await call({
      items: [{ id: '1', title: '功夫女足', year: '2024' }],
    });
    const body = (await res.json()) as { degraded: boolean; results: object };
    expect(body.degraded).toBe(true);
    expect(body.results).toEqual({});
    expect(writeJsonCache).not.toHaveBeenCalled();
  });

  it('does not cache a lookup where some sources timed out', async () => {
    (searchFromApi as jest.Mock).mockImplementation(
      async (
        site: { key: string },
        title: string,
        options: { onFailure: () => void }
      ) => {
        if (site.key === 's3') {
          options.onFailure();
          return [];
        }
        return [hit(site.key, { area: '韩国', class: '剧情' })];
      }
    );
    const res = await call({
      items: [{ id: '1', title: '功夫女足', year: '2024' }],
    });
    const body = (await res.json()) as {
      degraded: boolean;
      results: Record<string, { regions: string[] }>;
    };
    expect(body.degraded).toBe(false);
    expect(body.results['1'].regions).toEqual(['韩国']);
    expect(writeJsonCache).not.toHaveBeenCalled();
  });
});
