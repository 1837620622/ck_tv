import {
  downSourceKeys,
  fingerprintOf,
  listEndpoint,
  parseListPayload,
  watchBatch,
  withChanges,
} from './source-watch';

describe('listEndpoint', () => {
  it('uses the configured api and only switches on the list action', () => {
    expect(listEndpoint('https://bfzyapi.com/api.php/provide/vod')).toBe(
      'https://bfzyapi.com/api.php/provide/vod?ac=list&pg=1'
    );
    expect(listEndpoint('https://example.com/api.php/provide/vod?foo=1')).toBe(
      'https://example.com/api.php/provide/vod?foo=1&ac=list&pg=1'
    );
  });
});

describe('parseListPayload', () => {
  it('keeps ordinary rows and drops adult categories', () => {
    const samples = parseListPayload({
      list: [
        {
          vod_id: 7,
          vod_name: '剧集',
          vod_remarks: '更新至2集',
          vod_time: '12:00:00',
          type_name: '国产剧',
        },
        { vod_id: 8, vod_name: '某片', type_name: '伦理' },
        { vod_id: '', vod_name: '没编号' },
      ],
    });
    expect(samples).toEqual([
      {
        id: '7',
        title: '剧集',
        remarks: '更新至2集',
        time: '12:00:00',
        typeName: '国产剧',
      },
    ]);
  });
});

describe('withChanges', () => {
  const sample = {
    id: '7',
    title: '剧集',
    remarks: '更新至2集',
    time: '2026-10-17 00:57:33',
    typeName: '国产剧',
  };

  it('marks a source changed only when a successful fingerprint moves', () => {
    const previous = [
      {
        key: 'bfzy',
        name: '暴风资源',
        ok: true,
        ms: 10,
        fingerprint: fingerprintOf([sample]),
        changed: false,
        samples: [sample],
      },
    ];
    const next = withChanges(previous, [
      {
        ...previous[0],
        fingerprint: fingerprintOf([{ ...sample, remarks: '更新至3集' }]),
      },
    ]);
    expect(next[0].changed).toBe(true);
    expect(
      withChanges(previous, [{ ...previous[0], ok: false, fingerprint: '' }])[0]
        .changed
    ).toBe(false);
  });
});

describe('downSourceKeys', () => {
  it('returns only sources that failed the probe', () => {
    expect(
      downSourceKeys({
        checkedAt: 1,
        sources: [
          {
            key: 'a',
            name: '甲',
            ok: false,
            ms: 1,
            fingerprint: '',
            changed: false,
            samples: [],
          },
          {
            key: 'b',
            name: '乙',
            ok: true,
            ms: 1,
            fingerprint: '1',
            changed: false,
            samples: [],
          },
        ],
      })
    ).toEqual(['a']);
    expect(downSourceKeys(null)).toEqual([]);
  });
});

describe('watchBatch', () => {
  it('returns a slice instead of every site', () => {
    const sites = Array.from({ length: 10 }, (_, index) => ({
      key: String(index),
      name: String(index),
      api: 'https://example.com/api',
    }));
    expect(watchBatch(sites, 4).length).toBeLessThanOrEqual(4);
    expect(watchBatch(sites.slice(0, 2), 4)).toHaveLength(2);
  });
});
