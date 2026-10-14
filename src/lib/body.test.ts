// jsdom 测试环境没有 TextDecoder，用 Node 自带的补上
import { TextDecoder as NodeTextDecoder } from 'util';

import { readJsonBody } from './body';

if (typeof globalThis.TextDecoder === 'undefined') {
  // @ts-expect-error 测试替身，只需要 decode
  globalThis.TextDecoder = NodeTextDecoder;
}

const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

// 按给定分块吐出数据的假请求；reader 的读取次数可以用来确认是否真的停读了
function fakeRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {}
) {
  let index = 0;
  const reader = {
    read: jest.fn(async () =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined }
    ),
    cancel: jest.fn(async () => undefined),
  };
  const request = {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    body: { getReader: () => reader },
  } as unknown as Request;
  return { request, reader };
}

describe('readJsonBody', () => {
  it('解析限制内的 JSON', async () => {
    const { request } = fakeRequest([bytes('{"password":"abc"}')]);
    const result = await readJsonBody(request, 1024);
    expect(result).toEqual({ ok: true, data: { password: 'abc' } });
  });

  it('正好等于上限时放行', async () => {
    const text = '{"a":"' + 'x'.repeat(10) + '"}';
    const { request } = fakeRequest([bytes(text)]);
    const result = await readJsonBody(request, Buffer.byteLength(text));
    expect(result.ok).toBe(true);
  });

  it('声明的长度超过上限时不读取请求体', async () => {
    const { request, reader } = fakeRequest([bytes('{}')], {
      'content-length': '999999',
    });
    const result = await readJsonBody(request, 1024);
    expect(result).toEqual({
      ok: false,
      status: 413,
      error: '请求体过大',
    });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('没有声明长度时，边读边计数，超限即停止读取', async () => {
    const big = new Uint8Array(4096).fill(0x61);
    const { request, reader } = fakeRequest([big, big, big]);
    const result = await readJsonBody(request, 4096);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(413);
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.read).toHaveBeenCalledTimes(2);
  });

  it('非法 JSON 返回 400', async () => {
    const { request } = fakeRequest([bytes('{not json')]);
    const result = await readJsonBody(request, 1024);
    expect(result).toEqual({
      ok: false,
      status: 400,
      error: '请求格式不正确',
    });
  });

  it('没有请求体时按空 JSON 处理，返回 400', async () => {
    const request = {
      headers: { get: () => null },
      body: null,
    } as unknown as Request;
    const result = await readJsonBody(request, 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});
