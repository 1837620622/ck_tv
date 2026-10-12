// 该包只提供 ESM 入口，jest 无法解析，这里用替身代替：测试环境不是 Cloudflare，取不到请求上下文
jest.mock(
  '@cloudflare/next-on-pages',
  () => ({ getOptionalRequestContext: () => undefined }),
  { virtual: true }
);

import { beginAttempt, clientKey, recordSuccess } from './throttle';

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_SECONDS = 15 * 60;

function req(headers: Record<string, string> = {}): Request {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Request;
}

describe('login throttle', () => {
  const now = 1_000_000;

  it('allows MAX_FAILURES attempts and locks the next one', () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(beginAttempt('t1|user', now)).toBe(0);
    }
    expect(beginAttempt('t1|user', now)).toBe(LOCK_SECONDS);
  });

  it('counts synchronously, so a burst cannot exceed the limit', () => {
    const results = Array.from({ length: 50 }, () =>
      beginAttempt('t2|burst', now)
    );
    expect(results.filter((wait) => wait === 0)).toHaveLength(MAX_FAILURES);
  });

  it('clears the counter after a successful attempt', () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) beginAttempt('t3|ok', now);
    recordSuccess('t3|ok');
    for (let i = 0; i < MAX_FAILURES; i++) {
      expect(beginAttempt('t3|ok', now)).toBe(0);
    }
  });

  it('resets an unlocked counter once the window has passed', () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) beginAttempt('t4|window', now);
    const later = now + WINDOW_MS + 1;
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      expect(beginAttempt('t4|window', later)).toBe(0);
    }
  });

  it('keeps an active lock after the window has passed', () => {
    for (let i = 0; i < MAX_FAILURES; i++) beginAttempt('t5|lock', now);
    expect(beginAttempt('t5|lock', now + WINDOW_MS + 1)).toBeGreaterThan(0);
  });

  it('keeps active locks when the store overflows', () => {
    for (let i = 0; i < MAX_FAILURES; i++) beginAttempt('t6|victim', now);
    for (let i = 0; i < 5000; i++) beginAttempt(`t6|flood${i}`, now);
    expect(beginAttempt('t6|victim', now)).toBeGreaterThan(0);
  });

  it('ignores client-supplied forwarding headers unless TRUST_PROXY is set', () => {
    delete process.env.TRUST_PROXY;
    expect(clientKey(req({ 'x-forwarded-for': '1.1.1.1' }), 'Owner')).toBe(
      'anon|owner'
    );
    expect(clientKey(req({ 'cf-connecting-ip': '2.2.2.2' }), 'owner')).toBe(
      'anon|owner'
    );
  });

  it('takes the rightmost forwarded hop when TRUST_PROXY is set', () => {
    process.env.TRUST_PROXY = 'true';
    try {
      expect(
        clientKey(req({ 'x-forwarded-for': 'evil, 3.3.3.3' }), 'owner')
      ).toBe('3.3.3.3|owner');
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });

  it('bounds the account part of the key', () => {
    const key = clientKey(req(), 'a'.repeat(10_000));
    expect(key).toBe(`anon|${'a'.repeat(64)}`);
  });
});
