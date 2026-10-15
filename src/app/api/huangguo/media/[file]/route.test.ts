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

function textResponse(text: string, status = 200) {
  const bytes = Buffer.from(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length'
          ? String(bytes.byteLength)
          : null,
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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
  });

  it('returns a fresh playlist and does not pass through the key fields', async () => {
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
      .mockResolvedValueOnce(
        textResponse(
          '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/k"\nhttps://cdn.example/0.ts\n'
        )
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = (await GET(playlist('id=12&ep=1'))) as unknown as {
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
    };
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/vnd.apple.mpegurl');
    expect(res.headers['Cache-Control']).toContain('no-store');
    const text = Buffer.from(res.body).toString('utf8');
    expect(text.startsWith('#EXTM3U')).toBe(true);
    expect(text).not.toContain('secret-key');
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      'https://cdn.example/videos/ep1.m3u8?auth_key=1'
    );
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
