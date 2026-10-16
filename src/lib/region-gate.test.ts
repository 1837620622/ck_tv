import {
  countryOf,
  GATE_COOKIE,
  GATE_TOKEN,
  gateOpen,
  isForeignCountry,
  passwordMatches,
} from './region-gate';

function requestOf(header: string | null, platform?: string) {
  return {
    headers: {
      get(name: string) {
        return name.toLowerCase() === 'cf-ipcountry' ? header : null;
      },
    },
    cf: platform === undefined ? undefined : { country: platform },
  };
}

describe('column region gate', () => {
  it('blocks mainland China, Hong Kong, and Taiwan', () => {
    for (const code of ['CN', 'HK', 'TW', 'cn', 'hk', 'tw']) {
      expect(isForeignCountry(code.trim().toUpperCase())).toBe(false);
    }
  });

  it('allows other countries and rejects unknown codes', () => {
    for (const code of ['US', 'JP', 'SG', 'GB', 'DE', 'MO']) {
      expect(isForeignCountry(code)).toBe(true);
    }
    for (const code of ['', 'XX', 'T1', 'CHINA', 'CNH', 'A']) {
      expect(isForeignCountry(code)).toBe(false);
    }
  });

  it('prefers the platform country over a caller-supplied header', () => {
    expect(countryOf(requestOf('US', 'CN'))).toBe('CN');
    expect(countryOf(requestOf('HK'))).toBe('HK');
    expect(countryOf(requestOf(null, 'jp'))).toBe('JP');
    expect(countryOf(requestOf('  tw  '))).toBe('TW');
    expect(countryOf(requestOf('US', ''))).toBe('');
  });

  it('ignores a forged header when the edge context already has a country', () => {
    const symbol = Symbol.for('__cloudflare-request-context__');
    const holder = globalThis as unknown as Record<symbol, unknown>;
    const previous = holder[symbol];
    holder[symbol] = { cf: { country: 'CN' } };
    try {
      expect(countryOf(requestOf('US', 'JP'))).toBe('CN');
      holder[symbol] = { cf: { country: '  tw ' } };
      expect(countryOf(requestOf('US'))).toBe('TW');
      holder[symbol] = { cf: {} };
      expect(countryOf(requestOf('JP'))).toBe('');
    } finally {
      if (previous === undefined) delete holder[symbol];
      else holder[symbol] = previous;
    }
  });

  it('keeps the cookie from opening a blocked region', () => {
    const blocked = requestOf('CN');
    blocked.headers = {
      get(name: string) {
        const key = name.toLowerCase();
        if (key === 'cf-ipcountry') return 'CN';
        if (key === 'cookie') return `${GATE_COOKIE}=${GATE_TOKEN}`;
        return null;
      },
    };
    expect(isForeignCountry(countryOf(blocked))).toBe(false);
    expect(gateOpen(blocked)).toBe(false);
    expect(passwordMatches('wrong-code')).toBe(false);
    expect(passwordMatches('chuankangkk')).toBe(true);
    expect(passwordMatches('  CHUANKANGKK  ')).toBe(true);
  });
});
