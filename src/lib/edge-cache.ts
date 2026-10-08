// Cloudflare Workers 的 fetch 扩展，字段名与官方 RequestInitCfProperties 一致。
// cacheEverything 让 JSON 接口也能进边缘缓存；cacheTtl 强制缓存秒数，不受上游 no-cache 影响。
// cacheTtlByStatus 按状态码分开：成功结果多留一会儿，5xx 不缓存。
// 不设置 cacheKey，该字段只在企业版稳定可用。

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
    'Cache-Control': `public, max-age=${browserSeconds}, stale-while-revalidate=${edgeSeconds}`,
    'CDN-Cache-Control': `public, max-age=${edgeSeconds}, stale-while-revalidate=${
      edgeSeconds * 2
    }`,
  };
}
