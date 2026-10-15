import { detailHuangguo } from './huangguo';

function detailResponse(cover: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        id: 12,
        title: '神瞳觉醒',
        cover,
        episodes: [
          { ep_num: 1, title: '第1集' },
          { ep_num: 2, title: '第2集' },
        ],
      },
    }),
  };
}

describe('detailHuangguo', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('keeps a drleao cover and does not prefetch signed play urls', async () => {
    const fetchMock = jest.fn(async () =>
      detailResponse(
        'https://pic.drleao.cn/upload/a.jpg?auth_key=1792000000-0-0-abc'
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const detail = await detailHuangguo('12');
    expect(detail.poster).toContain('/api/huangguo/cover?u=');
    expect(decodeURIComponent(detail.poster)).toContain('pic.drleao.cn');
    expect(detail.episodes).toEqual([
      '/api/huangguo/media/playlist.m3u8?id=12&ep=1',
      '/api/huangguo/media/playlist.m3u8?id=12&ep=2',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = (fetchMock.mock.calls as unknown[][]).map((call) =>
      String(call[0] ?? '')
    );
    expect(requested.join('\n')).not.toContain('/play?');
  });

  it('still accepts the previous cover host and drops any other host', async () => {
    global.fetch = jest.fn(async () =>
      detailResponse('https://pic.wirqed.cn/cover/a.jpg')
    ) as unknown as typeof fetch;
    const kept = await detailHuangguo('12');
    expect(decodeURIComponent(kept.poster)).toContain('pic.wirqed.cn');

    global.fetch = jest.fn(async () =>
      detailResponse('https://evil.example/a.jpg')
    ) as unknown as typeof fetch;
    const dropped = await detailHuangguo('12');
    expect(dropped.poster).toBe('');
  });

  it('refuses an underage title before asking for a play url', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { id: 9, title: '幼女', cover: '', episodes: [{ ep_num: 1 }] },
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(detailHuangguo('9')).rejects.toThrow('内容不可用');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
