import {
  listingStamp,
  mergeSearchBodies,
  shouldReplaceListing,
} from './search-cache';

describe('mergeSearchBodies', () => {
  it('replaces sources that answered and keeps sources that did not', () => {
    const previous = JSON.stringify({
      line: 'cn',
      results: [
        { source: 'a', id: '1', episode_count: 10, title: '剧' },
        { source: 'b', id: '2', episode_count: 3, title: '剧' },
      ],
    });
    const next = JSON.stringify({
      line: 'cn',
      results: [
        {
          source: 'a',
          id: '1',
          episode_count: 12,
          title: '剧',
          remarks: '更新至12集',
        },
      ],
    });
    expect(JSON.parse(mergeSearchBodies(previous, next) || '{}')).toEqual({
      line: 'cn',
      results: [
        {
          source: 'a',
          id: '1',
          episode_count: 12,
          title: '剧',
          remarks: '更新至12集',
        },
        { source: 'b', id: '2', episode_count: 3, title: '剧' },
      ],
    });
  });

  it('does not wipe a cached list when the new round is empty', () => {
    expect(
      mergeSearchBodies(
        '{"results":[{"source":"a","id":"1"}]}',
        '{"results":[]}'
      )
    ).toBeNull();
  });
});

describe('shouldReplaceListing', () => {
  const current = [
    { source: 'a', id: '1', episode_count: 10, remarks: '更新至10集' },
  ];

  it('accepts a same-length list when the episode count changed', () => {
    expect(
      shouldReplaceListing(current, [
        { source: 'a', id: '1', episode_count: 11, remarks: '更新至11集' },
      ])
    ).toBe(true);
    expect(listingStamp(current)).not.toBe(
      listingStamp([
        { source: 'a', id: '1', episode_count: 11, remarks: '更新至11集' },
      ])
    );
  });

  it('keeps the current list when the next one is shorter or identical', () => {
    const longer = [
      ...current,
      { source: 'b', id: '2', episode_count: 4, remarks: '' },
    ];
    expect(shouldReplaceListing(longer, [])).toBe(false);
    expect(shouldReplaceListing(longer, current)).toBe(false);
    expect(shouldReplaceListing(current, current)).toBe(false);
  });
});
