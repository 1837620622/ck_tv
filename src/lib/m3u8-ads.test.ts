import { filterAdBreaks } from './m3u8-ads';

const cueBlock = [
  '#EXTINF:10.0,',
  's1.ts',
  '#EXT-X-CUE-OUT:DURATION=10',
  '#EXTINF:10.0,',
  'ad1.ts',
  '#EXT-X-CUE-IN',
  '#EXTINF:10.0,',
  's2.ts',
  '#EXT-X-ENDLIST',
];

describe('filterAdBreaks', () => {
  it('removes a cue-out ad from a clear playlist', () => {
    const playlist = ['#EXTM3U', ...cueBlock].join('\n');
    const result = filterAdBreaks(playlist);
    expect(result.removedSegments).toBe(1);
    expect(result.text).not.toContain('ad1.ts');
  });

  it('leaves AES-128 playlists without an explicit IV untouched', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key"',
      ...cueBlock,
    ].join('\n');
    const result = filterAdBreaks(playlist);
    expect(result.removedSegments).toBe(0);
    expect(result.text).toBe(playlist);
  });

  it('still filters AES-128 playlists that carry an explicit IV', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="k.key",IV=0x00000000000000000000000000000001',
      ...cueBlock,
    ].join('\n');
    const result = filterAdBreaks(playlist);
    expect(result.removedSegments).toBe(1);
  });
});
