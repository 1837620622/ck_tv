import {
  clearFailures,
  recordFailure,
  retryAfterSeconds,
} from './attempt-limit';

const T0 = 1_750_000_000_000;
const WINDOW_SECONDS = 15 * 60;

describe('password attempt limit', () => {
  it('allows five failures and blocks the sixth attempt', () => {
    const key = 'limit-five';
    for (let i = 0; i < 5; i += 1) {
      expect(retryAfterSeconds(key, T0)).toBe(0);
      recordFailure(key, T0);
    }
    expect(retryAfterSeconds(key, T0)).toBe(WINDOW_SECONDS);
    expect(retryAfterSeconds(key, T0 + 60_000)).toBe(WINDOW_SECONDS - 60);
  });

  it('opens again once the window has passed', () => {
    const key = 'limit-window';
    for (let i = 0; i < 5; i += 1) recordFailure(key, T0);
    expect(retryAfterSeconds(key, T0 + WINDOW_SECONDS * 1000)).toBe(0);
  });

  it('clears the count after a successful unlock', () => {
    const key = 'limit-clear';
    for (let i = 0; i < 5; i += 1) recordFailure(key, T0);
    clearFailures(key);
    expect(retryAfterSeconds(key, T0)).toBe(0);
  });

  it('counts each client separately', () => {
    for (let i = 0; i < 5; i += 1) recordFailure('limit-a', T0);
    expect(retryAfterSeconds('limit-a', T0)).toBeGreaterThan(0);
    expect(retryAfterSeconds('limit-b', T0)).toBe(0);
  });
});
