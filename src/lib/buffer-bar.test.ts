import {
  bufferedAhead,
  bufferSegments,
  formatAhead,
  readRanges,
} from './buffer-bar';

function timeRanges(pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as TimeRanges;
}

describe('buffer bar', () => {
  it('draws every buffered range, not only the last one', () => {
    const ranges = readRanges(
      timeRanges([
        [0, 30],
        [300, 360],
      ])
    );
    expect(bufferSegments(ranges, 600)).toEqual([
      { left: 0, width: 5 },
      { left: 50, width: 10 },
    ]);
  });

  it('joins ranges separated by a tiny gap between fragments', () => {
    expect(
      bufferSegments(
        [
          [10, 20],
          [20.2, 30],
        ],
        100
      )
    ).toEqual([{ left: 10, width: 20 }]);
  });

  it('draws nothing for live streams or before the duration is known', () => {
    expect(bufferSegments([[0, 10]], Infinity)).toEqual([]);
    expect(bufferSegments([[0, 10]], NaN)).toEqual([]);
    expect(bufferSegments([[0, 10]], 0)).toEqual([]);
  });

  it('clamps ranges that run past the duration', () => {
    expect(bufferSegments([[90, 120]], 100)).toEqual([{ left: 90, width: 10 }]);
  });

  it('measures the buffer ahead of the playhead in the range that holds it', () => {
    const ranges: Array<[number, number]> = [
      [0, 30],
      [300, 360],
    ];
    expect(bufferedAhead(ranges, 12)).toBe(18);
    expect(bufferedAhead(ranges, 320)).toBe(40);
    expect(bufferedAhead(ranges, 100)).toBe(0);
    // 落在片段之间的小缝里也算
    expect(bufferedAhead(ranges, 299.8)).toBeCloseTo(60.2);
  });

  it('formats the label in seconds and minutes', () => {
    expect(formatAhead(0.4)).toBe('缓冲中');
    expect(formatAhead(32.9)).toBe('已缓冲 32 秒');
    expect(formatAhead(120)).toBe('已缓冲 2 分');
    expect(formatAhead(95)).toBe('已缓冲 1 分 35 秒');
  });

  it('skips ranges that disappear while being read', () => {
    const flaky = {
      length: 2,
      start: (i: number) => {
        if (i === 1) throw new Error('gone');
        return 0;
      },
      end: () => 10,
    } as TimeRanges;
    expect(readRanges(flaky)).toEqual([[0, 10]]);
    expect(readRanges(undefined)).toEqual([]);
  });
});
