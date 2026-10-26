import type { SearchResult } from '@/lib/types';

import {
  episodeCountOf,
  latestEpisodeCount,
  pickFastest,
  sourcesWithEpisode,
} from './source-pick';

function line(
  source: string,
  rank: number,
  count: number,
  slim = false
): SearchResult {
  return {
    id: '1',
    source,
    source_name: source,
    source_rank: rank,
    title: 'Doctor X',
    poster: '',
    year: '2026',
    episodes: slim
      ? []
      : Array.from(
          { length: count },
          (_, i) => `https://${source}.example/ep${i + 1}.m3u8`
        ),
    episode_count: count,
  } as unknown as SearchResult;
}

const PLAYLIST = '#EXTM3U\n#EXTINF:4,\na.ts\n';

function delayedFetch(delays: Record<string, number | 'fail' | 'html'>) {
  return (url: string, init?: RequestInit) =>
    new Promise<{ ok: boolean; text(): Promise<string> }>((resolve, reject) => {
      const host = new URL(url).hostname.split('.')[0];
      const delay = delays[host];
      init?.signal?.addEventListener('abort', () => reject(new Error('abort')));
      if (delay === 'fail') return reject(new Error('network'));
      setTimeout(
        () =>
          resolve({
            ok: true,
            text: async () => (delay === 'html' ? '<html>' : PLAYLIST),
          }),
        typeof delay === 'number' ? delay : 0
      );
    });
}

describe('episode counts', () => {
  it('uses the line that has updated the furthest', () => {
    const lines = [line('a', 1, 5), line('b', 2, 6, true), line('c', 3, 3)];
    expect(latestEpisodeCount(lines)).toBe(6);
    expect(episodeCountOf(lines[1])).toBe(6);
    expect(latestEpisodeCount([], line('d', 1, 4))).toBe(4);
  });

  it('keeps only lines that have the wanted episode, in config order', () => {
    const lines = [line('c', 3, 6), line('a', 1, 5), line('b', 2, 6)];
    expect(sourcesWithEpisode(lines, 5).map((l) => l.source)).toEqual([
      'b',
      'c',
    ]);
    expect(
      sourcesWithEpisode(lines, 5, new Set(['b:1'])).map((l) => l.source)
    ).toEqual(['c']);
  });
});

describe('pickFastest', () => {
  it('returns the line whose playlist comes back first', async () => {
    const lines = [line('a', 1, 6), line('b', 2, 6), line('c', 3, 6)];
    const winner = await pickFastest(lines, 5, {
      fetchImpl: delayedFetch({ a: 120, b: 10, c: 60 }),
    });
    expect(winner?.source).toBe('b');
  });

  it('ignores lines that fail or answer with something other than a playlist', async () => {
    const lines = [line('a', 1, 6), line('b', 2, 6), line('c', 3, 6)];
    const winner = await pickFastest(lines, 0, {
      fetchImpl: delayedFetch({ a: 'fail', b: 'html', c: 40 }),
    });
    expect(winner?.source).toBe('c');
  });

  it('gives up within the time budget so the caller falls back to config order', async () => {
    const lines = [line('a', 1, 6), line('b', 2, 6)];
    const started = Date.now();
    const winner = await pickFastest(lines, 0, {
      budgetMs: 50,
      fetchImpl: delayedFetch({ a: 500, b: 500 }),
    });
    expect(winner).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('returns null when every line fails', async () => {
    const lines = [line('a', 1, 6), line('b', 2, 6)];
    expect(
      await pickFastest(lines, 0, {
        fetchImpl: delayedFetch({ a: 'fail', b: 'fail' }),
      })
    ).toBeNull();
  });

  it('does not probe lines without a playable address', async () => {
    const fetchImpl = jest.fn(delayedFetch({ a: 5 }));
    const lines = [line('a', 1, 6), line('b', 2, 6, true)];
    // 只有一条能测时直接用它，不必发请求
    expect((await pickFastest(lines, 0, { fetchImpl }))?.source).toBe('a');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
