import {
  encodeHuangguoRequest,
  httpMessageComplete,
  huangguoUpstreamPath,
  preparePlaylist,
  readHttpMessage,
} from '@/lib/huangguo-playlist';

const HOST = 'yd-hls.hzjvlo.cn';
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;

interface TlsSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  closed: Promise<void>;
  close: () => Promise<void>;
}

// 构建期的 edge 沙箱没有这个模块。放进函数里，收集页面数据时不会去加载它。
async function openSocket(): Promise<TlsSocket> {
  const sockets = (await import(
    /* webpackIgnore: true */ 'cloudflare:sockets'
  )) as {
    connect: (
      address: { hostname: string; port: number },
      options: { secureTransport: 'on'; allowHalfOpen: boolean }
    ) => TlsSocket;
  };
  return sockets.connect(
    { hostname: HOST, port: 443 },
    { secureTransport: 'on', allowHalfOpen: true }
  );
}

async function readLimited(
  readable: ReadableStream<Uint8Array>
): Promise<Uint8Array | null> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) return null;
      chunks.push(value);
      if (messageReady(chunks, total)) break;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 读到一半被关掉时，锁可能已经失效。
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes;
}

function messageReady(chunks: Uint8Array[], total: number): boolean {
  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return httpMessageComplete(bytes);
}

interface ByteRead {
  bytes: Uint8Array | null;
  why: string;
}

async function requestBytes(path: string): Promise<ByteRead> {
  let socket: TlsSocket;
  try {
    socket = await openSocket();
  } catch (error) {
    return { bytes: null, why: `connect:${cleanError(error)}` };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<ByteRead>((resolve) => {
    timer = setTimeout(() => {
      socket.close().catch(() => undefined);
      resolve({ bytes: null, why: 'timeout' });
    }, TIMEOUT_MS);
  });
  const done = (async (): Promise<ByteRead> => {
    const writer = socket.writable.getWriter();
    await writer.write(encodeHuangguoRequest(path));
    // 出站代理把写端关闭当成整条连接结束。响应回来之前不能关写端。
    const bytes = await readLimited(socket.readable);
    if (bytes === null) return { bytes: null, why: 'too-large' };
    if (bytes.length > 0) return { bytes, why: '' };
    return { bytes: null, why: await closedWhy(socket) };
  })();
  done.catch(() => undefined);
  try {
    return await Promise.race([done, timed]);
  } catch (error) {
    return { bytes: null, why: `connect:${cleanError(error)}` };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await socket.close();
    } catch {
      // 已经关掉时再关会抛错。
    }
  }
}

export interface PlaylistRead {
  body: string;
  why: string;
}

function closedWhy(socket: TlsSocket): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('empty'), 300);
    socket.closed.then(
      () => {
        clearTimeout(timer);
        resolve('empty');
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(`connect:${cleanError(error)}`);
      }
    );
  });
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\?[^ ]*/g, '')
    .replace(/[^ -~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function headTag(bytes: Uint8Array): string {
  let text = '';
  const stop = Math.min(8, bytes.length);
  for (let index = 0; index < stop; index += 1) {
    const code = bytes[index];
    text += code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
  }
  return text;
}

// fetch 子请求一定带 CF-Worker，源站会因此回同一份清单。套接字上的请求头是这里写的。
export async function readHuangguoPlaylist(
  target: string
): Promise<PlaylistRead> {
  let path = huangguoUpstreamPath(target);
  if (!path) return { body: '', why: 'bad-path' };
  for (let hop = 0; hop < 2 && path; hop += 1) {
    const loaded = await requestBytes(path);
    if (loaded.why) return { body: '', why: loaded.why };
    const bytes = loaded.bytes;
    if (!bytes || bytes.length === 0) return { body: '', why: 'empty' };
    const message = readHttpMessage(bytes);
    if (!message) return { body: '', why: `not-http:${headTag(bytes)}` };
    if (message.status === 200) {
      const body = preparePlaylist(message.body, `https://${HOST}${path}`);
      if (!body) {
        return {
          body: '',
          why: message.body.includes('853acaba4721cceab535b64e6831f05a')
            ? 'decoy'
            : 'bad-playlist',
        };
      }
      return { body, why: 'ok' };
    }
    if (message.status < 300 || message.status >= 400 || !message.location) {
      return { body: '', why: `status-${message.status}` };
    }
    let next = '';
    try {
      next = huangguoUpstreamPath(
        new URL(message.location, `https://${HOST}${path}`).toString()
      );
    } catch {
      next = '';
    }
    if (!next || next === path) return { body: '', why: 'bad-redirect' };
    path = next;
  }
  return { body: '', why: 'empty' };
}
