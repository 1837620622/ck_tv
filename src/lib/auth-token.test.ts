/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto';

import {
  AUTH_MAX_AGE_MS,
  createAuthCookieValue,
  verifyAuthCookieValue,
} from './auth-token';

// jest 的 node 环境没有全局 crypto；边缘运行时与 Node 18+ 都有 Web Crypto，这里补上同一套接口
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});

const T0 = 1_750_000_000_000;

describe('auth cookie token', () => {
  const saved = {
    AUTH_SECRET: process.env.AUTH_SECRET,
    PASSWORD: process.env.PASSWORD,
  };

  beforeEach(() => {
    process.env.PASSWORD = 'test-pass-123';
    delete process.env.AUTH_SECRET;
  });

  afterAll(() => {
    process.env.AUTH_SECRET = saved.AUTH_SECRET;
    process.env.PASSWORD = saved.PASSWORD;
  });

  it('accepts a freshly issued token', async () => {
    const cookie = await createAuthCookieValue(T0);
    expect(await verifyAuthCookieValue(cookie, T0 + 60_000)).toBe(true);
  });

  it('expires after seven days on the server, not only in the browser', async () => {
    const cookie = await createAuthCookieValue(T0);
    expect(await verifyAuthCookieValue(cookie, T0 + AUTH_MAX_AGE_MS - 1)).toBe(
      true
    );
    expect(await verifyAuthCookieValue(cookie, T0 + AUTH_MAX_AGE_MS + 1)).toBe(
      false
    );
  });

  it('rejects an issue time far in the future', async () => {
    const cookie = await createAuthCookieValue(T0 + 10 * 60_000);
    expect(await verifyAuthCookieValue(cookie, T0)).toBe(false);
  });

  it('rejects a token whose issue time was edited, since iat is signed', async () => {
    const cookie = await createAuthCookieValue(T0);
    const data = JSON.parse(decodeURIComponent(cookie));
    data.iat = T0 + 1_000_000;
    const forged = encodeURIComponent(JSON.stringify(data));
    expect(await verifyAuthCookieValue(forged, T0 + 1_000_000)).toBe(false);
  });

  it('rejects the old password-only format and malformed values', async () => {
    const legacy = encodeURIComponent(
      JSON.stringify({ signature: 'a'.repeat(64) })
    );
    expect(await verifyAuthCookieValue(legacy, T0)).toBe(false);
    expect(await verifyAuthCookieValue(undefined, T0)).toBe(false);
    expect(await verifyAuthCookieValue('not json', T0)).toBe(false);
    expect(await verifyAuthCookieValue('null', T0)).toBe(false);
  });

  it('does not verify with the password when AUTH_SECRET is configured', async () => {
    const withPasswordOnly = await createAuthCookieValue(T0);
    process.env.AUTH_SECRET = 'a-random-secret-of-at-least-32-bytes-long';
    expect(await verifyAuthCookieValue(withPasswordOnly, T0)).toBe(false);

    const withSecret = await createAuthCookieValue(T0);
    expect(await verifyAuthCookieValue(withSecret, T0)).toBe(true);
  });

  it('a token signed for one password is rejected after the password changes', async () => {
    const cookie = await createAuthCookieValue(T0);
    process.env.PASSWORD = 'another-password';
    expect(await verifyAuthCookieValue(cookie, T0)).toBe(false);
  });
});
