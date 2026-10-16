import { isGatedKey } from './record-gate';

describe('isGatedKey', () => {
  it('treats adult sources and AI 黄果 as gated', () => {
    expect(isGatedKey('zy91md+1')).toBe(true);
    expect(isGatedKey('huangguo+3')).toBe(true);
  });

  it('leaves ordinary sources alone', () => {
    expect(isGatedKey('normal-source+1')).toBe(false);
    expect(isGatedKey('no-plus-sign')).toBe(false);
  });
});
