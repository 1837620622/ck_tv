import { filterAdBreaks } from './m3u8-ads';

const BASE = 'https://main.example.com/video/index.m3u8';

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

// 正片分段，相对地址，属于 BASE 的域名
function mainSegments(count: number): string[] {
  return Array.from({ length: count }).flatMap((_, n) => [
    '#EXTINF:10.0,',
    `seg${n}.ts`,
  ]);
}

// 一段被不连续标记框住的插播，每段 seconds 秒，全部来自 host
function fencedBlock(count: number, host: string, seconds = 10): string[] {
  return [
    '#EXT-X-DISCONTINUITY',
    ...Array.from({ length: count }).flatMap((_, n) => [
      `#EXTINF:${seconds.toFixed(1)},`,
      `https://${host}/ad${n}.ts`,
    ]),
    '#EXT-X-DISCONTINUITY',
  ];
}

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

  it('removes a short single-host fenced block without a base url', () => {
    const playlist = [
      '#EXTM3U',
      ...mainSegments(10),
      ...fencedBlock(1, 'main.example.com'),
      ...mainSegments(10),
    ].join('\n');
    const result = filterAdBreaks(playlist);
    expect(result.removedSegments).toBe(1);
  });
});

describe('filterAdBreaks foreign-host ads', () => {
  it('removes a fenced block served from another host and keeps the main one', () => {
    const playlist = [
      '#EXTM3U',
      ...mainSegments(10),
      ...fencedBlock(2, 'ads.example.net'),
      ...mainSegments(10),
      '#EXT-X-ENDLIST',
    ].join('\n');
    const result = filterAdBreaks(playlist, BASE);
    expect(result.removedSegments).toBe(2);
    expect(result.removedSeconds).toBe(20);
    expect(result.text).not.toContain('ads.example.net');
    expect(result.text.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    expect(result.text).toContain('seg9.ts');
    expect(result.text).toContain('seg0.ts');
  });

  it('does nothing without a base url, because the main host is unknown', () => {
    const playlist = [
      '#EXTM3U',
      ...mainSegments(10),
      ...fencedBlock(2, 'ads.example.net'),
      ...mainSegments(10),
    ].join('\n');
    const result = filterAdBreaks(playlist);
    expect(result.removedSegments).toBe(0);
    expect(result.text).toBe(playlist);
  });

  it('keeps a foreign block longer than the single-block limit', () => {
    const playlist = [
      '#EXTM3U',
      ...mainSegments(40),
      ...fencedBlock(13, 'ads.example.net'),
      ...mainSegments(10),
    ].join('\n');
    const result = filterAdBreaks(playlist, BASE);
    expect(result.removedSegments).toBe(0);
    expect(result.text).toContain('ads.example.net');
  });

  it('caps the total foreign ad time at 20 percent of the episode', () => {
    // 正片 200 秒，两段各 60 秒的外站插播：预算 64 秒，只能删第一段
    const playlist = [
      '#EXTM3U',
      ...mainSegments(10),
      ...fencedBlock(6, 'a.example.net'),
      ...mainSegments(10),
      ...fencedBlock(6, 'b.example.net'),
      '#EXT-X-ENDLIST',
    ].join('\n');
    const result = filterAdBreaks(playlist, BASE);
    expect(result.removedSegments).toBe(6);
    expect(result.removedSeconds).toBe(60);
    expect(result.text).not.toContain('a.example.net');
    expect(result.text).toContain('b.example.net');
  });

  it('keeps a fenced block that stays on the main host', () => {
    const playlist = [
      '#EXTM3U',
      ...mainSegments(20),
      ...fencedBlock(4, 'main.example.com'),
      ...mainSegments(10),
    ].join('\n');
    const result = filterAdBreaks(playlist, BASE);
    expect(result.removedSegments).toBe(0);
  });

  it('keeps a fenced block that mixes hosts', () => {
    const block = [
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:60.0,',
      'https://main.example.com/video/part.ts',
      '#EXTINF:60.0,',
      'https://ads.example.net/ad.ts',
      '#EXT-X-DISCONTINUITY',
    ];
    const playlist = [
      '#EXTM3U',
      ...mainSegments(20),
      ...block,
      ...mainSegments(10),
    ].join('\n');
    const result = filterAdBreaks(playlist, BASE);
    expect(result.removedSegments).toBe(0);
  });
});
