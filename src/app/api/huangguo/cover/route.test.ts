import { createCipheriv } from 'crypto';

jest.mock(
  '@cloudflare/next-on-pages',
  () => ({ getOptionalRequestContext: () => undefined }),
  { virtual: true }
);
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
    static json(body: unknown, init?: { status?: number }) {
      return { body, status: init?.status ?? 200, headers: {} };
    }
  },
}));
jest.mock('@/lib/edge-cache', () => ({
  readJsonCache: jest.fn(async () => null),
  writeCached: jest.fn(),
}));

import { GET } from './route';

// jsdom 测试环境没有 Response；路由在边缘运行时用它写缓存，这里只需要能构造
if (typeof (globalThis as { Response?: unknown }).Response === 'undefined') {
  (globalThis as { Response?: unknown }).Response = class {
    body: unknown;
    headers: Map<string, string>;
    constructor(body: unknown, init?: { headers?: Record<string, string> }) {
      this.body = body;
      this.headers = new Map(Object.entries(init?.headers ?? {}));
    }
  };
}

// 与 huangguo-image.ts 里的密钥、向量一致
const KEY = Buffer.from(
  '102_53_100_57_54_53_100_102_55_53_51_51_54_50_55_48'.split('_').map(Number)
);
const IV = Buffer.from(
  '57_55_98_54_48_51_57_52_97_98_99_50_102_98_101_49'.split('_').map(Number)
);

const TARGET = 'https://pic.wirqed.cn/cover/a.jpg';

// 一张最小的 JPEG：SOI + 填充 + EOI
const jpegPlain = () =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(40, 7),
    Buffer.from([0xff, 0xd9]),
  ]);

function upstream(status: number, bytes: Buffer) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-length' ? String(bytes.length) : null,
    },
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : ((sent = true), { done: false, value: new Uint8Array(bytes) }),
          cancel: async () => undefined,
        };
      },
    },
  };
}

const request = (url: string) => ({ url } as unknown as Request);
const coverUrl = `https://localhost/api/huangguo/cover?u=${encodeURIComponent(
  TARGET
)}`;

describe('GET /api/huangguo/cover', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('serves a plaintext JPEG from upstream', async () => {
    global.fetch = jest.fn(async () =>
      upstream(200, jpegPlain())
    ) as unknown as typeof fetch;
    const res = (await GET(request(coverUrl))) as unknown as {
      status: number;
      headers: Record<string, string>;
    };
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
  });

  it('decrypts an AES-128-CBC upstream cover', async () => {
    const cipher = createCipheriv('aes-128-cbc', KEY, IV);
    cipher.setAutoPadding(false);
    const plain = jpegPlain();
    const padded = Buffer.concat([
      plain,
      Buffer.alloc((16 - (plain.length % 16)) % 16),
    ]);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    global.fetch = jest.fn(async () =>
      upstream(200, encrypted)
    ) as unknown as typeof fetch;
    const res = (await GET(request(coverUrl))) as unknown as {
      status: number;
      headers: Record<string, string>;
    };
    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
  });

  it('follows a redirect that stays on the allowed host', async () => {
    const redirect = {
      ok: false,
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location'
            ? 'https://pic.wirqed.cn/cover/b.jpg'
            : null,
      },
      body: null,
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(upstream(200, jpegPlain()));
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = (await GET(request(coverUrl))) as unknown as {
      status: number;
      headers: Record<string, string>;
    };
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://pic.wirqed.cn/cover/b.jpg'
    );
  });

  it('does not follow a redirect off the allowed host', async () => {
    const redirect = {
      ok: false,
      status: 302,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'location'
            ? 'https://evil.example/x.jpg'
            : null,
      },
      body: null,
    };
    const fetchMock = jest.fn().mockResolvedValueOnce(redirect);
    global.fetch = fetchMock as unknown as typeof fetch;
    const res = (await GET(request(coverUrl))) as unknown as { status: number };
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when upstream fails or the target host is not allowed', async () => {
    global.fetch = jest.fn(async () =>
      upstream(500, Buffer.alloc(0))
    ) as unknown as typeof fetch;
    const failed = (await GET(request(coverUrl))) as unknown as {
      status: number;
    };
    expect(failed.status).toBe(404);

    const other = `https://localhost/api/huangguo/cover?u=${encodeURIComponent(
      'https://evil.example/a.jpg'
    )}`;
    const blocked = (await GET(request(other))) as unknown as {
      status: number;
    };
    expect(blocked.status).toBe(400);
  });
});
