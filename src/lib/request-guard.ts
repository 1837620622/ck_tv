// 边缘接口的通用防护：拒绝跨站页面的调用，并按 IP 限制频率。
// 计数只在当前实例内有效（边缘运行时每个实例各记各的），所以正式环境还要在 Cloudflare 上加限流规则。

const MAX_KEYS = 10_000;

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

// Cloudflare 会带上真实来源 IP。拿不到时返回 null（Docker 等没有 Cloudflare 的部署）。
export function clientIp(request: Request): string | null {
  return request.headers.get('cf-connecting-ip')?.trim() || null;
}

// 浏览器会带 Sec-Fetch-Site。跨站页面借用我们的接口（盗链、替别人转写视频）一律拒绝。
// 没有这个头的是脚本或原生应用，这里不拦。
export function isCrossSite(request: Request): boolean {
  return request.headers.get('sec-fetch-site') === 'cross-site';
}

// 固定窗口计数：同一个 key 在 windowMs 内最多 limit 次。
// 返回 0 表示放行；否则是还要等的秒数。
export function takeQuota(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now()
): number {
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (!bucket && buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= limit) return 0;
  return Math.ceil((bucket.resetAt - now) / 1000);
}
