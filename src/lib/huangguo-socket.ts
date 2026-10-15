import {
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

function requestOf(path: string): string {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${HOST}`,
    'User-Agent: Mozilla/5.0',
    'Accept: */*',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
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

async function requestBytes(path: string): Promise<Uint8Array | null> {
  const socket = await openSocket();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      socket.close().catch(() => undefined);
      resolve(null);
    }, TIMEOUT_MS);
  });
  const done = (async () => {
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(requestOf(path)));
    await writer.close();
    return readLimited(socket.readable);
  })();
  done.catch(() => undefined);
  try {
    return await Promise.race([done, timed]);
  } catch {
    // 套接字被运行时拒绝，或对端中途断开。这一集按没打开处理。
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await socket.close();
    } catch {
      // 已经关掉时再关会抛错。
    }
  }
}

// fetch 子请求一定带 CF-Worker，源站会因此回同一份清单。套接字上的请求头是这里写的。
export async function readHuangguoPlaylist(target: string): Promise<string> {
  let path = huangguoUpstreamPath(target);
  for (let hop = 0; hop < 2 && path; hop += 1) {
    const bytes = await requestBytes(path);
    if (!bytes) return '';
    const message = readHttpMessage(bytes);
    if (!message) return '';
    if (message.status === 200) {
      return preparePlaylist(message.body, `https://${HOST}${path}`);
    }
    if (message.status < 300 || message.status >= 400 || !message.location) {
      return '';
    }
    let next = '';
    try {
      next = huangguoUpstreamPath(
        new URL(message.location, `https://${HOST}${path}`).toString()
      );
    } catch {
      next = '';
    }
    if (!next || next === path) return '';
    path = next;
  }
  return '';
}
