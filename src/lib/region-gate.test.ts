/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto';

import {
  countryOf,
  GATE_COOKIE,
  GATE_MAX_AGE_SECONDS,
  gateConfigured,
  gateDenial,
  gateOpen,
  isForeignCountry,
  issueGateCookie,
  passwordMatches,
} from './region-gate';

// 与边缘运行时一样，使用 Web Crypto
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
});

const SECRET = 'a-random-secret-of-at-least-32-characters';
const OTHER_SECRET = 'another-random-secret-of-32-characters-long';
const T0 = 1_750_000_000_000;
const PLATFORM = Symbol.for('__cloudflare-request-context__');

type Opts = { cf?: string; header?: string; cookie?: string };

function requestOf({ cf, header, cookie }: Opts) {
  const values: Record<string, string> = {};
  if (header !== undefined) values['cf-ipcountry'] = header;
  if (cookie !== undefined) values.cookie = `${GATE_COOKIE}=${cookie}`;
  return {
    cf: cf === undefined ? undefined : { country: cf },
    headers: { get: (name: string) => values[name.toLowerCase()] ?? null },
  };
}

// 测试里签 cookie 时密钥一定已配置，拿不到说明测试环境有问题，直接报错
async function tokenAt(now: number = Date.now()): Promise<string> {
  const token = await issueGateCookie(now);
  if (!token) throw new Error('gate secret is not configured in the test');
  return token;
}

const saved = {
  PASSWORD: process.env.GATE_PASSWORD,
  SECRET: process.env.GATE_SECRET,
  TRUST: process.env.GATE_TRUST_COUNTRY_HEADER,
};

function setEnv(
  name: 'GATE_PASSWORD' | 'GATE_SECRET' | 'GATE_TRUST_COUNTRY_HEADER',
  value: string | undefined
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  setEnv('GATE_PASSWORD', 'Open-Sesame');
  setEnv('GATE_SECRET', SECRET);
  setEnv('GATE_TRUST_COUNTRY_HEADER', undefined);
});

afterAll(() => {
  setEnv('GATE_PASSWORD', saved.PASSWORD);
  setEnv('GATE_SECRET', saved.SECRET);
  setEnv('GATE_TRUST_COUNTRY_HEADER', saved.TRUST);
});

describe('country source', () => {
  it('uses the platform country over any request field', () => {
    const holder = globalThis as unknown as Record<symbol, unknown>;
    holder[PLATFORM] = { cf: { country: 'CN' } };
    try {
      expect(countryOf(requestOf({ cf: 'JP', header: 'JP' }))).toBe('CN');
    } finally {
      delete holder[PLATFORM];
    }
  });

  it('uses request.cf when there is no platform context', () => {
    expect(countryOf(requestOf({ cf: 'jp' }))).toBe('JP');
    expect(countryOf(requestOf({ cf: '  tw  ' }))).toBe('TW');
    expect(countryOf(requestOf({ cf: '' }))).toBe('');
  });

  it('ignores CF-IPCountry by default, because callers can send it', () => {
    expect(countryOf(requestOf({ header: 'JP' }))).toBe('');
  });

  it('reads CF-IPCountry only when the deployment opts in', () => {
    setEnv('GATE_TRUST_COUNTRY_HEADER', 'true');
    expect(countryOf(requestOf({ header: ' jp ' }))).toBe('JP');
    setEnv('GATE_TRUST_COUNTRY_HEADER', 'yes');
    expect(countryOf(requestOf({ header: 'JP' }))).toBe('');
  });
});

describe('region rules', () => {
  it('blocks mainland China, Hong Kong, Macau, and Taiwan', () => {
    for (const code of ['CN', 'HK', 'MO', 'TW', 'cn', 'hk', 'mo', 'tw']) {
      expect(isForeignCountry(code.trim().toUpperCase())).toBe(false);
    }
  });

  it('allows other countries and rejects unknown codes', () => {
    for (const code of ['US', 'JP', 'SG', 'GB', 'DE']) {
      expect(isForeignCountry(code)).toBe(true);
    }
    for (const code of ['', 'XX', 'T1', 'CHINA', 'CNH', 'A']) {
      expect(isForeignCountry(code)).toBe(false);
    }
  });
});

describe('password', () => {
  it('never matches when GATE_PASSWORD is not set', async () => {
    setEnv('GATE_PASSWORD', undefined);
    expect(await passwordMatches('')).toBe(false);
    expect(await passwordMatches('chuankangkk')).toBe(false);
  });

  it('matches the configured password, ignoring case and spaces', async () => {
    expect(await passwordMatches('open-sesame')).toBe(true);
    expect(await passwordMatches('  OPEN-SESAME  ')).toBe(true);
    expect(await passwordMatches('open-sesam')).toBe(false);
    expect(await passwordMatches('chuankangkk')).toBe(false);
  });

  it('reports configured only when both password and secret are set', () => {
    expect(gateConfigured()).toBe(true);
    setEnv('GATE_SECRET', 'too-short');
    expect(gateConfigured()).toBe(false);
    setEnv('GATE_SECRET', SECRET);
    setEnv('GATE_PASSWORD', undefined);
    expect(gateConfigured()).toBe(false);
  });
});

describe('cookie', () => {
  it('is not issued without a signing secret', async () => {
    setEnv('GATE_SECRET', undefined);
    expect(await issueGateCookie(T0)).toBeNull();
  });

  it('opens a foreign request that carries a freshly issued cookie', async () => {
    const token = await tokenAt(T0);
    expect(
      await gateOpen(requestOf({ cf: 'JP', cookie: token }), T0 + 60_000)
    ).toBe(true);
  });

  it('rejects the fixed token that earlier versions used', async () => {
    expect(
      await gateOpen(
        requestOf({ cf: 'JP', cookie: 'b7e1c4a09d6f4e2a8c5d17f03b6a9e84' }),
        T0
      )
    ).toBe(false);
  });

  it('expires after seven days on the server', async () => {
    const token = await tokenAt(T0);
    const request = requestOf({ cf: 'JP', cookie: token });
    const maxMs = GATE_MAX_AGE_SECONDS * 1000;
    expect(await gateOpen(request, T0 + maxMs - 1000)).toBe(true);
    expect(await gateOpen(request, T0 + maxMs + 2000)).toBe(false);
  });

  it('rejects an issue time edited to be later, since the signature covers it', async () => {
    const token = await tokenAt(T0);
    const [, mac] = token.split('.');
    const forged = `${Math.floor(T0 / 1000) + 1000}.${mac}`;
    expect(
      await gateOpen(requestOf({ cf: 'JP', cookie: forged }), T0 + 1000 * 1000)
    ).toBe(false);
  });

  it('rejects a cookie signed with a different secret', async () => {
    const token = await tokenAt(T0);
    setEnv('GATE_SECRET', OTHER_SECRET);
    expect(await gateOpen(requestOf({ cf: 'JP', cookie: token }), T0)).toBe(
      false
    );
  });

  it('rejects a cookie that claims a time far in the future', async () => {
    const token = await tokenAt(T0 + 10 * 60_000);
    expect(await gateOpen(requestOf({ cf: 'JP', cookie: token }), T0)).toBe(
      false
    );
  });

  it('keeps a valid cookie from opening a blocked region', async () => {
    const token = await tokenAt(T0);
    const blocked = requestOf({ cf: 'CN', cookie: token });
    expect(await gateOpen(blocked, T0)).toBe(false);
    expect(await gateDenial(blocked)).toBe('region');
  });

  it('reports a gate denial for a foreign request without a valid cookie', async () => {
    expect(await gateDenial(requestOf({ cf: 'JP' }))).toBe('gate');
    expect(await gateDenial(requestOf({ cf: 'JP', cookie: 'garbage' }))).toBe(
      'gate'
    );
  });

  it('lets a foreign request with a current cookie through', async () => {
    const token = await tokenAt();
    expect(await gateDenial(requestOf({ cf: 'JP', cookie: token }))).toBeNull();
  });
});
