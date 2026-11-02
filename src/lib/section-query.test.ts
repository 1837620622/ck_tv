import { sectionQuery } from './section-query';

describe('sectionQuery', () => {
  it('空值不写进地址，默认状态下地址为空', () => {
    expect(
      sectionQuery([
        ['q', ''],
        ['source', ''],
        ['t', ''],
        ['page', ''],
      ])
    ).toBe('');
  });

  it('按给定顺序写入有值的参数，并正确编码', () => {
    expect(
      sectionQuery([
        ['q', 'a b'],
        ['source', 'x'],
        ['page', '3'],
      ])
    ).toBe('q=a+b&source=x&page=3');
  });

  it('跳过空值但保留其余参数的顺序', () => {
    expect(
      sectionQuery([
        ['q', ''],
        ['t', 'hot'],
        ['page', '2'],
      ])
    ).toBe('t=hot&page=2');
  });
});
