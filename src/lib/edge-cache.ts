// Cloudflare Workers 的 fetch 扩展，字段名与官方 RequestInitCfProperties 一致。
// cacheEverything 让 JSON 也能进边缘缓存；cacheTtl 强制缓存秒数，不受上游 no-cache 影响。
// cacheTtlByStatus 按状态码分开：成功结果多留一会儿，5xx 不缓存。
// 不设置 cacheKey，该字段只在企业版稳定可用。
// 访问者看到的聚合接口默认是 DYNAMIC：Cache-Control 不会自动把 Pages Function 的响应存进边缘。
// 聚合结果要用 caches.default（Cache API）。Cache API 认 Cache-Control 里的 s-maxage。

export function edgeFetchInit(
  headers: HeadersInit,
  signal: AbortSignal,
  ttlSeconds: number
): RequestInit {
  return {
    headers,
    signal,
    cf: {
      cacheEverything: true,
      cacheTtl: ttlSeconds,
      cacheTtlByStatus: {
        '200-299': ttlSeconds,
        '300-399': 30,
        '400-499': 5,
        '500-599': 0,
      },
    },
  } as RequestInit;
}

export function jsonCacheHeaders(edgeSeconds: number, browserSeconds: number) {
  return {
    'Cache-Control': `public, max-age=${browserSeconds}, s-maxage=${edgeSeconds}, stale-while-revalidate=${edgeSeconds}`,
    'CDN-Cache-Control': `public, s-maxage=${edgeSeconds}, stale-while-revalidate=${
      edgeSeconds * 2
    }`,
  };
}

type WaitUntilCtx = {
  waitUntil(promise: Promise<unknown>): void;
};

function cacheStorage(): Cache | null {
  const host = globalThis as typeof globalThis & {
    caches?: { default?: Cache };
  };
  return host.caches?.default ?? null;
}

// Node（Docker）里没有 Cache API。退回到进程内存：条目数、总字节、单条大小都有上限，过期即失效。
const MEMORY_MAX_ENTRIES = 300;
const MEMORY_MAX_BYTES = 40 * 1024 * 1024;
const MEMORY_MAX_ENTRY_BYTES = 1.5 * 1024 * 1024;
const MEMORY_MAX_TTL_SECONDS = 3600;

type MemoryEntry = {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
  expiresAt: number;
};

const memoryCache = new Map<string, MemoryEntry>();
let memoryBytes = 0;

function memoryTtlSeconds(headers: Headers): number {
  const cacheControl = headers.get('cache-control') || '';
  const sMaxAge = /s-maxage=(\d+)/.exec(cacheControl);
  const maxAge = /max-age=(\d+)/.exec(cacheControl);
  const ttl = sMaxAge ? Number(sMaxAge[1]) : maxAge ? Number(maxAge[1]) : 0;
  return Math.min(ttl, MEMORY_MAX_TTL_SECONDS);
}

function memoryDrop(key: string) {
  const old = memoryCache.get(key);
  if (!old) return;
  memoryBytes -= old.body.byteLength;
  memoryCache.delete(key);
}

function memoryGet(cacheUrl: string): Response | null {
  const hit = memoryCache.get(cacheUrl);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    memoryDrop(cacheUrl);
    return null;
  }
  return new Response(hit.body.slice(0), {
    status: hit.status,
    headers: hit.headers,
  });
}

function memoryPut(cacheUrl: string, response: Response) {
  const ttl = memoryTtlSeconds(response.headers);
  if (response.status !== 200 || ttl <= 0) return;
  response
    .clone()
    .arrayBuffer()
    .then((body) => {
      if (body.byteLength > MEMORY_MAX_ENTRY_BYTES) return;
      memoryDrop(cacheUrl);
      while (
        memoryCache.size > 0 &&
        (memoryCache.size >= MEMORY_MAX_ENTRIES ||
          memoryBytes + body.byteLength > MEMORY_MAX_BYTES)
      ) {
        memoryDrop(memoryCache.keys().next().value as string);
      }
      memoryCache.set(cacheUrl, {
        status: 200,
        headers: Array.from(response.headers.entries()),
        body,
        expiresAt: Date.now() + ttl * 1000,
      });
      memoryBytes += body.byteLength;
    })
    .catch(() => undefined);
}

export function cacheAgeSeconds(response: Response): number {
  const date = response.headers.get('date');
  if (!date) return 0;
  const timestamp = Date.parse(date);
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, (Date.now() - timestamp) / 1000);
}

// 缓存键用固定域名，只存在边缘内存里，不会真的去请求这个地址。
export async function readJsonCache(
  cacheUrl: string
): Promise<Response | null> {
  const cache = cacheStorage();
  if (!cache) return memoryGet(cacheUrl);
  try {
    const hit = await cache.match(new Request(cacheUrl, { method: 'GET' }));
    return hit ?? null;
  } catch {
    return null;
  }
}

// 封面、海报这类二进制也走同一套 Cache API。调用方自己带好 Content-Type 和 Cache-Control。
export function writeCached(
  ctx: WaitUntilCtx | undefined,
  cacheUrl: string,
  response: Response
) {
  const cache = cacheStorage();
  if (!cache) {
    memoryPut(cacheUrl, response);
    return;
  }
  const task = cache
    .put(new Request(cacheUrl, { method: 'GET' }), response)
    .catch(() => undefined);
  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  void task;
}

export function writeJsonCache(
  ctx: WaitUntilCtx | undefined,
  cacheUrl: string,
  body: string,
  edgeSeconds: number,
  browserSeconds: number
) {
  if (!body) return;
  const headers = jsonCacheHeaders(edgeSeconds, browserSeconds);
  const response = new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      date: new Date().toUTCString(),
      'cache-control': headers['Cache-Control'],
      'cdn-cache-control': headers['CDN-Cache-Control'],
    },
  });
  const cache = cacheStorage();
  if (!cache) {
    memoryPut(cacheUrl, response);
    return;
  }
  const task = cache
    .put(new Request(cacheUrl, { method: 'GET' }), response)
    .catch(() => undefined);
  if (ctx) {
    ctx.waitUntil(task);
    return;
  }
  void task;
}
