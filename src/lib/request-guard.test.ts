import { clientIp, isCrossSite, takeQuota } from './request-guard';

const T0 = 1_750_000_000_000;

function requestWith(headers: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

describe('takeQuota', () => {
  it('allows up to the limit inside one window, then reports the wait', () => {
    const key = 'quota-basic';
    for (let i = 0; i < 3; i += 1) {
      expect(takeQuota(key, 3, 60_000, T0)).toBe(0);
    }
    expect(takeQuota(key, 3, 60_000, T0 + 10_000)).toBe(50);
  });

  it('starts a new window after the window has passed', () => {
    const key = 'quota-window';
    for (let i = 0; i < 2; i += 1) takeQuota(key, 2, 60_000, T0);
    expect(takeQuota(key, 2, 60_000, T0 + 60_000)).toBe(0);
  });

  it('keeps keys independent', () => {
    for (let i = 0; i < 2; i += 1) takeQuota('quota-a', 2, 60_000, T0);
    expect(takeQuota('quota-a', 2, 60_000, T0)).toBeGreaterThan(0);
    expect(takeQuota('quota-b', 2, 60_000, T0)).toBe(0);
  });
});

describe('isCrossSite', () => {
  it('flags only browser requests that come from another site', () => {
    expect(isCrossSite(requestWith({ 'Sec-Fetch-Site': 'cross-site' }))).toBe(
      true
    );
    expect(isCrossSite(requestWith({ 'Sec-Fetch-Site': 'same-origin' }))).toBe(
      false
    );
    expect(isCrossSite(requestWith({ 'Sec-Fetch-Site': 'same-site' }))).toBe(
      false
    );
    expect(isCrossSite(requestWith({}))).toBe(false);
  });
});

describe('clientIp', () => {
  it('reads the Cloudflare client address, or null when there is none', () => {
    expect(clientIp(requestWith({ 'CF-Connecting-IP': ' 203.0.113.7 ' }))).toBe(
      '203.0.113.7'
    );
    expect(clientIp(requestWith({}))).toBeNull();
  });
});
