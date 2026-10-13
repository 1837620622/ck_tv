import {
  firstMatchPerSource,
  hasMeta,
  resourceVote,
  voteConsensus,
} from './meta-vote';
import type { SearchResult } from './types';

const result = (
  source: string,
  title: string,
  extra: Partial<SearchResult> = {}
): SearchResult =>
  ({
    id: `${source}-1`,
    title,
    poster: '',
    episodes: ['https://a.invalid/1.m3u8'],
    source,
    source_name: source,
    year: '2024',
    ...extra,
  } as SearchResult);

describe('resourceVote', () => {
  it('reads region aliases and genres from a resource result', () => {
    const vote = resourceVote(
      result('s1', '功夫女足', { area: '大陆,韩国', class: '剧情,喜剧,爱情' })
    );
    expect(vote.year).toBe('2024');
    expect(vote.regions).toEqual(['中国大陆', '韩国']);
    expect(vote.genres).toEqual(['剧情', '喜剧', '爱情']);
    expect(hasMeta(vote)).toBe(true);
  });

  it('treats an unknown year and unknown labels as missing', () => {
    const vote = resourceVote(
      result('s1', '功夫女足', { year: 'unknown', area: '外星', class: '未知' })
    );
    expect(vote.year).toBe('');
    expect(vote.regions).toEqual([]);
    expect(vote.genres).toEqual([]);
    expect(hasMeta(vote)).toBe(false);
  });
});

describe('firstMatchPerSource', () => {
  it('keeps only the first title match per source', () => {
    const matched = firstMatchPerSource(
      [
        result('s1', '功夫女足'),
        result('s1', '功夫女足'),
        result('s2', '功夫女足'),
      ],
      '功夫女足',
      '2024'
    );
    expect(matched.map((r) => r.source)).toEqual(['s1', 's2']);
  });

  it('rejects other seasons, trailers and different years', () => {
    const matched = firstMatchPerSource(
      [
        result('s1', '功夫女足 第二季'),
        result('s2', '功夫女足 预告'),
        result('s3', '功夫女足', { year: '2019' }),
        result('s4', '功夫女足', { year: 'unknown', area: '中国大陆' }),
      ],
      '功夫女足',
      '2024'
    );
    expect(matched.map((r) => r.source)).toEqual(['s4']);
  });

  it('skips an empty duplicate so the same source can still vote', () => {
    const matched = firstMatchPerSource(
      [
        result('s1', '流浪地球2', { year: '', area: undefined, class: '' }),
        result('s1', '流浪地球2', {
          year: '2023',
          area: '中国大陆',
          class: '科幻,剧情',
        }),
      ],
      '流浪地球2',
      ''
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].area).toBe('中国大陆');
    expect(hasMeta(resourceVote(matched[0]))).toBe(true);
  });

  it('does not count an undated remake as the source for an earlier year', () => {
    const matched = firstMatchPerSource(
      [
        result('s1', '三体 2023', { year: '', area: '美国', class: '科幻' }),
        result('s2', '三体', { year: '2010', area: '中国大陆' }),
      ],
      '三体',
      '2010'
    );
    expect(matched.map((r) => r.source)).toEqual(['s2']);
  });
});

describe('voteConsensus', () => {
  it('accepts a single responder directly', () => {
    const consensus = voteConsensus([
      { source: 'resource', regions: ['韩国'] },
    ]);
    expect(consensus.regions).toEqual(['韩国']);
  });

  it('needs a majority when two or more sources report a field', () => {
    const disagree = voteConsensus([
      { source: 'a', regions: ['中国大陆'] },
      { source: 'b', regions: ['韩国'] },
    ]);
    expect(disagree.regions).toEqual([]);

    const majority = voteConsensus([
      { source: 'a', regions: ['中国大陆'] },
      { source: 'b', regions: ['中国大陆'] },
      { source: 'c', regions: ['韩国'] },
    ]);
    expect(majority.regions).toEqual(['中国大陆']);
  });

  it('ignores sources that did not report the field when counting', () => {
    const consensus = voteConsensus([
      { source: 'a', genres: ['剧情'] },
      { source: 'b' },
      { source: 'c', genres: ['剧情', '悬疑'] },
    ]);
    expect(consensus.genres).toEqual(['剧情']);
  });

  it('takes the most common year and breaks ties by the first vote', () => {
    expect(
      voteConsensus([
        { source: 'a', year: '2024' },
        { source: 'b', year: '2024' },
        { source: 'c', year: '2023' },
      ]).year
    ).toBe('2024');
    expect(
      voteConsensus([
        { source: 'douban', year: '2023' },
        { source: 'b', year: '2024' },
      ]).year
    ).toBe('2023');
  });

  it('counts the voters that gave any field', () => {
    const consensus = voteConsensus([
      { source: 'a', year: '2024' },
      { source: 'b' },
      { source: 'c', genres: ['剧情'] },
    ]);
    expect(consensus.voters).toBe(2);
  });
});
