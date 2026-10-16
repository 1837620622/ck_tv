/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto';

import { GATE_PASSWORD, GATE_SIGNING_KEY } from './gate-config';
import {
  countryOf,
  GATE_COOKIE,
  GATE_MAX_AGE_SECONDS,
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

const savedTrust = process.env.GATE_TRUST_COUNTRY_HEADER;

function setTrust(value: string | undefined) {
  if (value === undefined) delete process.env.GATE_TRUST_COUNTRY_HEADER;
  else process.env.GATE_TRUST_COUNTRY_HEADER = value;
}

beforeEach(() => {
  setTrust(undefined);
});

afterAll(() => {
  setTrust(savedTrust);
});

describe('built-in gate settings', () => {
  it('has a password and a signing key that can be used', () => {
    expect(GATE_PASSWORD.trim()).not.toBe('');
    expect(GATE_SIGNING_KEY.length).toBeGreaterThanOrEqual(32);
    expect(GATE_SIGNING_KEY).not.toBe(GATE_PASSWORD);
  });
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
    setTrust('true');
    expect(countryOf(requestOf({ header: ' jp ' }))).toBe('JP');
    setTrust('yes');
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
  it('matches the built-in password, ignoring case and spaces', async () => {
    expect(await passwordMatches(GATE_PASSWORD)).toBe(true);
    expect(await passwordMatches(`  ${GATE_PASSWORD.toUpperCase()}  `)).toBe(
      true
    );
    expect(await passwordMatches(`${GATE_PASSWORD}x`)).toBe(false);
    expect(await passwordMatches('chuankangkk')).toBe(false);
  });

  it('never matches an empty code', async () => {
    expect(await passwordMatches('')).toBe(false);
    expect(await passwordMatches('   ')).toBe(false);
  });
});

describe('cookie', () => {
  it('opens a foreign request that carries a freshly issued cookie', async () => {
    const token = await issueGateCookie(T0);
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
    const token = await issueGateCookie(T0);
    const request = requestOf({ cf: 'JP', cookie: token });
    const maxMs = GATE_MAX_AGE_SECONDS * 1000;
    expect(await gateOpen(request, T0 + maxMs - 1000)).toBe(true);
    expect(await gateOpen(request, T0 + maxMs + 2000)).toBe(false);
  });

  it('rejects an issue time edited to be later, since the signature covers it', async () => {
    const token = await issueGateCookie(T0);
    const mac = token.slice(token.indexOf('.') + 1);
    const forged = `${Math.floor(T0 / 1000) + 1000}.${mac}`;
    expect(
      await gateOpen(requestOf({ cf: 'JP', cookie: forged }), T0 + 1000 * 1000)
    ).toBe(false);
  });

  it('rejects a cookie whose signature was changed', async () => {
    const token = await issueGateCookie(T0);
    const dot = token.indexOf('.');
    const mac = token.slice(dot + 1);
    const last = mac.slice(-1);
    const tampered = `${token.slice(0, dot)}.${mac.slice(0, -1)}${
      last === '0' ? '1' : '0'
    }`;
    expect(await gateOpen(requestOf({ cf: 'JP', cookie: tampered }), T0)).toBe(
      false
    );
  });

  it('rejects a cookie that claims a time far in the future', async () => {
    const token = await issueGateCookie(T0 + 10 * 60_000);
    expect(await gateOpen(requestOf({ cf: 'JP', cookie: token }), T0)).toBe(
      false
    );
  });

  it('keeps a valid cookie from opening a blocked region', async () => {
    const token = await issueGateCookie(T0);
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
    const token = await issueGateCookie();
    expect(await gateDenial(requestOf({ cf: 'JP', cookie: token }))).toBeNull();
  });
});
