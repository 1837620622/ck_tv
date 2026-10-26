import { coloName, parseTrace } from './edge-node';

const TRACE = `fl=123f45
h=tv.chuankangkk.top
ip=203.0.113.9
ts=1761460000.123
visit_scheme=https
uag=Mozilla/5.0
colo=HKG
sliver=none
http=http/2
loc=JP
tls=TLSv1.3
warp=off`;

describe('parseTrace', () => {
  it('reads the node and the visitor country', () => {
    expect(parseTrace(TRACE)).toEqual({ colo: 'HKG', country: 'JP' });
  });

  it('returns null when there is no node code, for example on a 404 page', () => {
    expect(parseTrace('<html>Not Found</html>')).toBeNull();
    expect(parseTrace('colo=\nloc=US')).toBeNull();
  });

  it('keeps the node even when the country is missing or odd', () => {
    expect(parseTrace('colo=lax\nloc=XYZ')).toEqual({
      colo: 'LAX',
      country: '',
    });
  });
});

describe('coloName', () => {
  it('names common nodes and falls back to the code', () => {
    expect(coloName('HKG')).toBe('香港 HKG');
    expect(coloName('sjc')).toBe('圣何塞 SJC');
    expect(coloName('QQQ')).toBe('QQQ');
  });
});
