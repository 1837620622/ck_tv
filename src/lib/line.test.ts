/**
 * @jest-environment node
 */
import { viewerLine } from './line';

const PLATFORM = Symbol.for('__cloudflare-request-context__');

function requestOf(header: string | null, cf?: string) {
  return {
    cf: cf === undefined ? undefined : { country: cf },
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'cf-ipcountry' ? header : null,
    },
  } as unknown as Request;
}

describe('viewerLine', () => {
  const savedTrust = process.env.GATE_TRUST_COUNTRY_HEADER;

  afterEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[PLATFORM];
    if (savedTrust === undefined) delete process.env.GATE_TRUST_COUNTRY_HEADER;
    else process.env.GATE_TRUST_COUNTRY_HEADER = savedTrust;
  });

  it('ignores a caller supplied CF-IPCountry', () => {
    delete process.env.GATE_TRUST_COUNTRY_HEADER;
    expect(viewerLine(requestOf('US'))).toBe('cn');
  });

  it('uses the platform country when the edge provides one', () => {
    (globalThis as unknown as Record<symbol, unknown>)[PLATFORM] = {
      cf: { country: 'JP' },
    };
    expect(viewerLine(requestOf('CN'))).toBe('global');
  });

  it('uses request.cf before any header', () => {
    expect(viewerLine(requestOf('CN', 'US'))).toBe('global');
    expect(viewerLine(requestOf('US', 'CN'))).toBe('cn');
  });
});
