// 口令错误次数限制：同一个 key（客户端 IP）连续错 5 次，15 分钟内不再接受尝试。
// 计数只在当前实例里有效（边缘运行时每个实例各记各的），所以正式环境还要在 Cloudflare 上给
// /api/gate 加一条限流规则，两层一起用。

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
// 防止有人用大量不同的 key 把表撑爆；超出时挤掉最早记录的那一条
const MAX_KEYS = 5000;

type Attempts = {
  failures: number;
  resetAt: number;
};

const attempts = new Map<string, Attempts>();

function current(key: string, now: number): Attempts | undefined {
  const entry = attempts.get(key);
  if (entry && entry.resetAt <= now) {
    attempts.delete(key);
    return undefined;
  }
  return entry;
}

// 还要等多少秒才能再试；返回 0 表示现在可以试。
export function retryAfterSeconds(
  key: string,
  now: number = Date.now()
): number {
  const entry = current(key, now);
  if (!entry || entry.failures < MAX_FAILURES) return 0;
  return Math.ceil((entry.resetAt - now) / 1000);
}

export function recordFailure(key: string, now: number = Date.now()): void {
  const entry = current(key, now);
  if (entry) {
    entry.failures += 1;
    return;
  }
  if (attempts.size >= MAX_KEYS) {
    const oldest = attempts.keys().next();
    if (!oldest.done) attempts.delete(oldest.value);
  }
  attempts.set(key, { failures: 1, resetAt: now + WINDOW_MS });
}

export function clearFailures(key: string): void {
  attempts.delete(key);
}
