import { isNearDoubanCdn, posterImageUrl } from './utils';

const DOUBAN =
  'http://img3.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg';

describe('posterImageUrl', () => {
  it('loads douban posters directly for visitors in mainland China, Hong Kong, Macau and Taiwan', () => {
    for (const zone of ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei']) {
      expect(posterImageUrl(DOUBAN, zone)).toBe(
        'https://img3.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg'
      );
    }
  });

  it('keeps the built-in proxy for douban posters elsewhere', () => {
    for (const zone of ['America/Los_Angeles', 'Asia/Tokyo', undefined]) {
      expect(posterImageUrl(DOUBAN, zone)).toBe(
        `/api/image-proxy?url=${encodeURIComponent(DOUBAN)}`
      );
    }
  });

  it('leaves other posters to the usual rules', () => {
    expect(posterImageUrl('/api/huangguo/cover?u=x', 'Asia/Shanghai')).toBe(
      '/api/huangguo/cover?u=x'
    );
    expect(posterImageUrl('', 'Asia/Shanghai')).toBe('');
  });

  it('knows which time zones are near the douban image servers', () => {
    expect(isNearDoubanCdn('Asia/Shanghai')).toBe(true);
    expect(isNearDoubanCdn('Asia/Singapore')).toBe(false);
    expect(isNearDoubanCdn(undefined)).toBe(false);
  });
});
