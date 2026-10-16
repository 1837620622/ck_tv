import { webcrypto } from 'node:crypto';
import { TextEncoder as NodeTextEncoder } from 'node:util';

jest.mock('next/server', () => ({
  NextResponse: {
    json: (
      body: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) => ({ body, status: init?.status ?? 200, headers: init?.headers ?? {} }),
  },
}));
jest.mock('@/lib/auth', () => ({ LOCAL_AUTH_SUBJECT: 'site' }));
jest.mock('@/lib/body', () => ({
  DEFAULT_JSON_BODY_BYTES: 1024,
  readJsonBody: jest.fn(async (req: { __json?: unknown }) => ({
    ok: true,
    data: req.__json,
  })),
}));
// 工厂函数在导入时就会执行，所以数据放在工厂里面
jest.mock('@/lib/db', () => {
  const record = {
    title: '测试',
    source_name: '示例源',
    index: 1,
    cover: '',
    year: '2024',
    total_episodes: 3,
    play_time: 0,
    total_time: 0,
    save_time: 0,
    search_title: '测试',
  };
  return {
    db: {
      savePlayRecord: jest.fn(async () => undefined),
      deletePlayRecord: jest.fn(async () => undefined),
      getAllPlayRecords: jest.fn(async () => ({
        'zy91md+1': record,
        'normal+2': record,
      })),
    },
    hasServerStorage: () => true,
  };
});

import { db } from '@/lib/db';
import { issueGateCookie } from '@/lib/region-gate';

import { DELETE, GET, POST } from './route';

const mockDb = db as unknown as Record<
  'savePlayRecord' | 'deletePlayRecord' | 'getAllPlayRecords',
  jest.Mock
>;

// 门控的签名用 Web Crypto；jsdom 环境里没有 subtle 和 TextEncoder，这里补上
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}
if (typeof globalThis.TextEncoder === 'undefined') {
  (globalThis as unknown as { TextEncoder?: unknown }).TextEncoder =
    NodeTextEncoder;
}

const record = {
  title: '测试',
  source_name: '示例源',
  index: 1,
  cover: '',
  year: '2024',
  total_episodes: 3,
  play_time: 0,
  total_time: 0,
  save_time: 0,
  search_title: '测试',
};

let gateCookie = '';
beforeAll(async () => {
  process.env.GATE_PASSWORD = 'records-test-password';
  process.env.GATE_SECRET = 'records-test-secret-of-at-least-32-chars';
  gateCookie = `cktv-gate=${(await issueGateCookie()) ?? ''}`;
});

beforeEach(() => {
  jest.clearAllMocks();
});

type Opts = {
  url?: string;
  country?: string;
  open?: boolean;
  json?: unknown;
};

function req({
  url = 'https://localhost/api/playrecords',
  country,
  open,
  json,
}: Opts) {
  return {
    url,
    cf: country ? { country } : undefined,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'cookie' && open ? gateCookie : null,
    },
    __json: json,
  } as unknown as Parameters<typeof POST>[0];
}

const postAdult = (opts: Partial<Opts> = {}) =>
  POST(
    req({
      ...opts,
      json: { key: 'zy91md+1', record },
    })
  );

describe('play records and the gate', () => {
  it('refuses to save an adult record when the gate is closed', async () => {
    const res = await postAdult({ country: 'JP' });
    expect(res.status).toBe(403);
    expect(mockDb.savePlayRecord).not.toHaveBeenCalled();
  });

  it('saves an adult record once the gate is open', async () => {
    const res = await postAdult({ country: 'JP', open: true });
    expect(res.status).toBe(200);
    expect(mockDb.savePlayRecord).toHaveBeenCalledWith(
      'site',
      'zy91md',
      '1',
      expect.any(Object)
    );
  });

  it('saves ordinary records regardless of the gate', async () => {
    const res = await POST(
      req({ country: 'CN', json: { key: 'normal+2', record } })
    );
    expect(res.status).toBe(200);
    expect(mockDb.savePlayRecord).toHaveBeenCalledWith(
      'site',
      'normal',
      '2',
      expect.any(Object)
    );
  });

  it('refuses to delete one adult record when the gate is closed', async () => {
    const res = await DELETE(
      req({
        country: 'JP',
        url: 'https://localhost/api/playrecords?key=zy91md%2B1',
      })
    );
    expect(res.status).toBe(403);
    expect(mockDb.deletePlayRecord).not.toHaveBeenCalled();
  });

  it('clearing everything keeps adult records for a visitor without the gate', async () => {
    const res = await DELETE(req({ country: 'JP' }));
    expect(res.status).toBe(200);
    expect(mockDb.deletePlayRecord).toHaveBeenCalledWith('site', 'normal', '2');
    expect(mockDb.deletePlayRecord).not.toHaveBeenCalledWith(
      'site',
      'zy91md',
      '1'
    );
  });

  it('clearing everything removes adult records for a visitor with the gate open', async () => {
    const res = await DELETE(req({ country: 'JP', open: true }));
    expect(res.status).toBe(200);
    expect(mockDb.deletePlayRecord).toHaveBeenCalledWith('site', 'zy91md', '1');
    expect(mockDb.deletePlayRecord).toHaveBeenCalledWith('site', 'normal', '2');
  });

  it('lists only ordinary records to a visitor without the gate', async () => {
    const res = await GET(req({ country: 'CN' }));
    expect(Object.keys(res.body as object)).toEqual(['normal+2']);
  });
});
