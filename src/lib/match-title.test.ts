import { titleParts, titlesMatch } from './match-title';

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
