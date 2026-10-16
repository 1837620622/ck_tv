jest.mock('next/server', () => ({
  NextResponse: class {
    body: unknown;
    status: number;
    headers: Record<string, string>;
    constructor(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = init?.headers ?? {};
    }

    static json(
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) {
      return new this(JSON.stringify(body), init);
    }
  },
}));

jest.mock('@/lib/huangguo-socket', () => ({
  readHuangguoPlaylist: jest.fn(async (target: string) => {
    if (String(target).includes('/videos/ep1')) {
      return {
        body: '#EXTM3U\nhttps://tp4.drleao.cn/a/111.ts\n',
        why: 'ok',
      };
    }
    if (String(target).includes('/videos/ep2')) {
      return {
        body: '#EXTM3U\nhttps://tp3.drleao.cn/b/222.ts\n',
        why: 'ok',
      };
    }
    return { body: '', why: 'empty' };
  }),
}));

import { readHuangguoPlaylist } from '@/lib/huangguo-socket';
import { GATE_COOKIE, GATE_TOKEN } from '@/lib/region-gate';

import { GET } from './route';

const playlistMock = readHuangguoPlaylist as unknown as jest.Mock;

const request = (url: string) =>
  ({
    url,
    headers: new Headers({
      'cf-ipcountry': 'JP',
      cookie: `${GATE_COOKIE}=${GATE_TOKEN}`,
    }),
  } as unknown as Request);
const playlist = (query: string) =>
  request(`https://localhost/api/huangguo/media/playlist.m3u8?${query}`);

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

const detail = {
  data: {
    id: 12,
    title: '神瞳觉醒',
    cover: '',
    episodes: [
      { ep_num: 1, title: '第1集' },
      { ep_num: 2, title: '第2集' },
    ],
  },
};

describe('GET /api/huangguo/media/playlist.m3u8', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
    playlistMock.mockClear();
  });

  it('returns that episode playlist and does not pass through the key fields', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            video_url: 'https://yd-hls.hzjvlo.cn/videos/ep1.m3u8?auth_key=1',
            video_key: 'secret-key',
            video_iv: 'secret-iv',
          },
        })
      )
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            video_url: 'https://yd-hls.hzjvlo.cn/videos/ep2.m3u8?auth_key=2',
            video_key: 'secret-key',
          },
        })
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const first = (await GET(playlist('id=12&ep=1'))) as unknown as {
      status: number;
      body: string;
      headers: Record<string, string>;
    };
    const second = (await GET(playlist('id=12&ep=2'))) as unknown as {
      status: number;
      body: string;
      headers: Record<string, string>;
    };
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toContain('111.ts');
    expect(second.body).toContain('222.ts');
    expect(first.body).not.toContain('222.ts');
    expect(second.body).not.toContain('111.ts');
    expect(first.headers['Cache-Control']).toContain('no-store');
    expect(first.headers['content-type']).toContain('mpegurl');
    expect(first.body).not.toContain('secret-key');
    expect(first.body).not.toContain('auth_key');
    expect(second.body).not.toContain('secret-key');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(playlistMock).toHaveBeenCalledTimes(2);
  });

  it('rejects mainland China, Hong Kong, and Taiwan before opening a playlist', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    for (const country of ['CN', 'HK', 'TW']) {
      const res = (await GET({
        url: 'https://localhost/api/huangguo/media/playlist.m3u8?id=12&ep=1',
        headers: new Headers({
          'cf-ipcountry': country,
          cookie: `${GATE_COOKIE}=${GATE_TOKEN}`,
        }),
      } as unknown as Request)) as unknown as { status: number };
      expect(res.status).toBe(403);
    }
    expect(playlistMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns only the absolute url when format=url', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            video_url: 'https://cdn.example/videos/ep2.m3u8?auth_key=2',
            video_key: 'secret-key',
          },
        })
      ) as unknown as typeof fetch;
    const res = (await GET(playlist('id=12&ep=2&format=url'))) as unknown as {
      status: number;
      body: string;
      headers: Record<string, string>;
    };
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(JSON.parse(res.body)).toEqual({
      url: 'https://cdn.example/videos/ep2.m3u8?auth_key=2',
    });
    expect(res.body).not.toContain('secret-key');
    expect(playlistMock).not.toHaveBeenCalled();
  });

  it('does not fetch a play url that is not a public https playlist', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({ data: { video_url: 'http://127.0.0.1/secret.m3u8' } })
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = (await GET(playlist('id=12&ep=1'))) as unknown as {
      status: number;
    };
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(playlistMock).not.toHaveBeenCalled();
  });

  it('does not open a socket for a playlist on another host', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            video_url: 'https://cdn.example/videos/ep1.m3u8?auth_key=1',
          },
        })
      ) as unknown as typeof fetch;
    const res = (await GET(playlist('id=12&ep=1'))) as unknown as {
      status: number;
      headers: Record<string, string>;
    };
    expect(res.status).toBe(404);
    expect(res.headers['x-ck-why']).toBe('bad-host');
    expect(playlistMock).not.toHaveBeenCalled();
  });

  it('rejects a bad id before calling upstream', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = (await GET(playlist('id=abc&ep=1'))) as unknown as {
      status: number;
    };
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
