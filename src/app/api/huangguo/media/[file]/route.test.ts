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
  },
}));

import { GET } from './route';

const request = (url: string) => ({ url } as unknown as Request);
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

function textResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

const episodeOne = [
  '#EXTM3U',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://tp.example/ep1.key",IV=0x01',
  'https://tp.example/ep1-0.ts?auth_key=1',
].join('\n');

const episodeTwo = ['#EXTM3U', 'https://tp.example/ep2-0.ts?auth_key=2'].join(
  '\n'
);

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
  });

  it('returns that episode playlist and does not pass through the key fields', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            video_url: 'https://cdn.example/videos/ep1.m3u8?auth_key=1',
            video_key: 'secret-key',
            video_iv: 'secret-iv',
          },
        })
      )
      .mockResolvedValueOnce(textResponse(episodeOne))
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            video_url: 'https://cdn.example/videos/ep2.m3u8?auth_key=2',
            video_key: 'secret-key',
          },
        })
      )
      .mockResolvedValueOnce(textResponse(episodeTwo));
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
    expect(first.headers['Cache-Control']).toContain('no-store');
    expect(first.headers['content-type']).toContain('mpegurl');
    expect(first.body).toContain('#EXTM3U');
    expect(first.body).toContain('https://tp.example/ep1-0.ts');
    expect(second.body).toContain('https://tp.example/ep2-0.ts');
    expect(first.body).not.toContain('secret-key');
    expect(second.body).not.toContain('ep1-0.ts');
    const calls = fetchMock.mock.calls as unknown[][];
    expect(calls).toHaveLength(6);
    const playlistInits = [calls[2][1], calls[5][1]] as Array<{
      cf?: unknown;
      cache?: unknown;
    }>;
    playlistInits.forEach((init) => {
      expect(init.cf).toBeUndefined();
      expect(init.cache).toBeUndefined();
    });
    expect(String(calls[2][0])).toContain('/videos/ep1.m3u8');
    expect(String(calls[5][0])).toContain('/videos/ep2.m3u8');
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
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual({
      url: 'https://cdn.example/videos/ep2.m3u8?auth_key=2',
    });
    expect(res.body).not.toContain('secret-key');
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
  });

  it('rejects a playlist whose segments are not absolute', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(detail))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { video_url: 'https://cdn.example/videos/ep1.m3u8?auth_key=1' },
        })
      )
      .mockResolvedValueOnce(textResponse('#EXTM3U\nsegment0.ts\n'));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = (await GET(playlist('id=12&ep=1'))) as unknown as {
      status: number;
      body: string | null;
    };
    expect(res.status).toBe(404);
    expect(res.body || '').not.toContain('segment0.ts');
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
