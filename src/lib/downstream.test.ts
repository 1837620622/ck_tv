import { extractPlayUrls } from './downstream';

describe('extractPlayUrls chooses one format per line', () => {
  it('keeps the main mp4 when a line has one trailer m3u8 and one mp4', () => {
    expect(
      extractPlayUrls(
        '预告$https://cdn.a/trailer.m3u8#正片$https://cdn.a/main.mp4'
      )
    ).toEqual(['https://cdn.a/main.mp4']);
  });

  it('still prefers hls when the m3u8 episodes are the majority', () => {
    expect(
      extractPlayUrls(
        '第1集$https://c/1.m3u8#第2集$https://c/2.m3u8#第3集$https://c/3.mp4'
      )
    ).toEqual(['https://c/1.m3u8', 'https://c/2.m3u8']);
  });

  it('keeps every episode when a line has no m3u8', () => {
    expect(
      extractPlayUrls('第1集$https://c/1.mp4#第2集$https://c/2.mp4')
    ).toEqual(['https://c/1.mp4', 'https://c/2.mp4']);
  });
});
