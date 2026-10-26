import { FRAMING_HEADERS } from './framing';

describe('framing protection', () => {
  it('lets only this site frame its own pages', () => {
    expect(FRAMING_HEADERS['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(FRAMING_HEADERS['Content-Security-Policy']).toBe(
      "frame-ancestors 'self'"
    );
  });
});
