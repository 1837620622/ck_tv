import {
  pickPlayable,
  titleParts,
  titlesMatch,
  titleYear,
  workKey,
} from './match-title';
import type { SearchResult } from './types';

const play = (title: string, year: string): SearchResult =>
  ({
    id: `${title}-${year}`,
    title,
    poster: '',
    episodes: ['01', '02'],
    source: 's1',
    source_name: 's1',
    year,
  } as SearchResult);

describe('titlesMatch with a year in the resource title', () => {
  it('matches a bare title against the same title with a year suffix', () => {
    expect(titlesMatch('三体 2023', '三体')).toBe(true);
    expect(titlesMatch('三体(2023)', '三体')).toBe(true);
    expect(titleParts('三体 2023')).toEqual({
      base: '三体',
      season: '',
      trailer: false,
    });
  });

  it('does not read the last two digits of a year as a season', () => {
    expect(titleParts('三体2023').season).toBe('');
    expect(titleParts('三体2023').base).toBe('三体');
  });
});

describe('titlesMatch keeps seasons and sequels apart', () => {
  it('reads a trailing single or double digit as a season', () => {
    expect(titleParts('流浪地球2').season).toBe('2');
    expect(titleParts('流浪地球2').base).toBe('流浪地球');
    expect(titlesMatch('流浪地球2', '流浪地球')).toBe(false);
    expect(titlesMatch('三体 第三季', '三体')).toBe(false);
    expect(titlesMatch('三体 第二季', '三体 2')).toBe(true);
  });

  it('keeps a sequel whose number looks like a year in the title', () => {
    expect(titleParts('银翼杀手2049').base).toBe('银翼杀手2049');
    expect(titlesMatch('银翼杀手2049', '银翼杀手')).toBe(false);
  });

  it('keeps trailers apart from the feature', () => {
    expect(titlesMatch('功夫女足 预告', '功夫女足')).toBe(false);
  });
});

describe('year taken from the title when the metadata has none', () => {
  it('reads a trailing year but not a title that is only a year', () => {
    expect(titleYear('三体 2023')).toBe('2023');
    expect(titleYear('银翼杀手2049')).toBe('');
    expect(titleYear('2046')).toBe('');
  });

  it('does not let an undated remake play for the earlier year', () => {
    const picked = pickPlayable(
      [play('三体 2023', ''), play('三体', '2010')],
      '三体',
      '2010',
      'tv'
    );
    expect(picked.map((item) => item.year)).toEqual(['2010']);
  });

  it('keeps an undated title with no year in its name', () => {
    const picked = pickPlayable([play('狂飙', '')], '狂飙', '2023', 'tv');
    expect(picked).toHaveLength(1);
  });

  it('gives a title-dated item its own work key', () => {
    expect(workKey('三体 2023', '', 30)).not.toBe(workKey('三体', '', 30));
    expect(workKey('三体 2023', '', 30)).toBe(workKey('三体', '2023', 30));
  });
});

describe('quality tags on the title do not change its identity', () => {
  it('strips every trailing quality tag, not only the last one', () => {
    expect(titleParts('流浪地球 HD国语中字').base).toBe('流浪地球');
    expect(titlesMatch('流浪地球 HD国语中字', '流浪地球')).toBe(true);
    expect(titlesMatch('流浪地球 国语 中字', '流浪地球')).toBe(true);
  });

  it('reads a season that sits in front of a quality tag', () => {
    expect(titleParts('流浪地球2 4K')).toEqual({
      base: '流浪地球',
      season: '2',
      trailer: false,
    });
    expect(titlesMatch('流浪地球2 4K', '流浪地球2')).toBe(true);
    expect(titlesMatch('流浪地球2 4K', '流浪地球')).toBe(false);
  });

  it('reads a year that sits in front of a quality tag', () => {
    expect(titleYear('三体 2023 4K')).toBe('2023');
    expect(titleYear('三体2023高清国语')).toBe('2023');
    expect(workKey('三体 2023 4K', 'unknown', 30)).toBe(
      workKey('三体 2023', '', 30)
    );
  });

  it('does not let a 4K copy of the 2023 remake play for the 2010 entry', () => {
    const picked = pickPlayable(
      [play('三体 2023 4K', 'unknown'), play('三体', '2010')],
      '三体',
      '2010',
      'tv'
    );
    expect(picked.map((item) => item.year)).toEqual(['2010']);
  });
});
