import { shouldWarmNextEpisode } from './warm-up';

describe('shouldWarmNextEpisode', () => {
  it('waits until the last two minutes or the last 15 percent', () => {
    expect(shouldWarmNextEpisode(600, 2700)).toBe(false);
    expect(shouldWarmNextEpisode(2590, 2700)).toBe(true);
    expect(shouldWarmNextEpisode(2300, 2700)).toBe(true);
    expect(shouldWarmNextEpisode(400, 600)).toBe(false);
    expect(shouldWarmNextEpisode(520, 600)).toBe(true);
  });

  it('never warms live streams or unknown durations', () => {
    expect(shouldWarmNextEpisode(100, Infinity)).toBe(false);
    expect(shouldWarmNextEpisode(100, NaN)).toBe(false);
  });
});
