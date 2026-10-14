// jsdom 测试环境没有 ReadableStream，用 Node 自带的
import { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { limitStream } from './limit-stream';

if (typeof globalThis.ReadableStream === 'undefined') {
  // @ts-expect-error 测试替身，只用到构造函数
  globalThis.ReadableStream = NodeReadableStream;
}

const chunked = (parts: string[]) =>
  new NodeReadableStream<Uint8Array>({
    start(controller) {
      parts.forEach((part) =>
        controller.enqueue(new Uint8Array(Buffer.from(part)))
      );
      controller.close();
    },
  }) as unknown as ReadableStream<Uint8Array>;

// 一直不吐数据的上游，用来验证空等超时
const stalled = () =>
  new NodeReadableStream<Uint8Array>({
    start() {
      // 什么都不入队，也不关闭
    },
  }) as unknown as ReadableStream<Uint8Array>;

async function drain(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const out: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out.length;
    out.push(value.byteLength);
  }
}

describe('limitStream', () => {
  it('passes the whole body through', async () => {
    const limited = limitStream(chunked(['abc', 'de']), {
      maxBytes: 100,
      idleMs: 1000,
    });
    expect(await drain(limited)).toBe(2);
  });

  it('errors out once the body passes the limit and stops reading', async () => {
    const limited = limitStream(chunked(['aaaa', 'bbbb', 'cccc']), {
      maxBytes: 6,
      idleMs: 1000,
    });
    await expect(drain(limited)).rejects.toThrow('超过大小上限');
  });

  it('ends the body when the upstream stays silent past the idle limit', async () => {
    const limited = limitStream(stalled(), { maxBytes: 100, idleMs: 20 });
    expect(await drain(limited)).toBe(0);
  });

  it('lets a slow but steady upstream finish', async () => {
    const slow = new NodeReadableStream<Uint8Array>({
      async start(controller) {
        for (const part of ['a', 'b', 'c']) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          controller.enqueue(new Uint8Array(Buffer.from(part)));
        }
        controller.close();
      },
    }) as unknown as ReadableStream<Uint8Array>;
    const limited = limitStream(slow, { maxBytes: 100, idleMs: 60 });
    expect(await drain(limited)).toBe(3);
  });
});
