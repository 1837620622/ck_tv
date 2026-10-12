// 口令尝试次数限制：按“来源 IP + 用户名”记录连续失败，达到上限后锁定一段时间。
// 状态只存在当前实例的内存里。Cloudflare 上每个实例各算各的，Docker 单进程则是全局的。
// 它挡的是单机的暴力尝试，不是分布式限流；要更严格需要在 WAF 上加速率规则或共享存储。

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_KEYS = 5000;

interface Entry {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

const store = new Map<string, Entry>();

export function clientKey(request: Request, account: string): string {
  const forwarded = (request.headers.get('x-forwarded-for') || '')
    .split(',')[0]
    .trim();
  const ip = request.headers.get('cf-connecting-ip') || forwarded || 'unknown';
  return `${ip}|${account.toLowerCase()}`;
}

// 还要等多少秒才能再试；0 表示没有锁定
export function lockedSeconds(key: string, now = Date.now()): number {
  const entry = store.get(key);
  if (!entry || entry.lockedUntil <= now) return 0;
  return Math.ceil((entry.lockedUntil - now) / 1000);
}

function prune(now: number) {
  store.forEach((entry, key) => {
    if (entry.lockedUntil <= now && now - entry.firstAt > WINDOW_MS) {
      store.delete(key);
    }
  });
  if (store.size >= MAX_KEYS) store.clear();
}

export function recordFailure(key: string, now = Date.now()) {
  if (store.size >= MAX_KEYS) prune(now);
  let entry = store.get(key);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    entry = { failures: 0, firstAt: now, lockedUntil: 0 };
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
  }
  store.set(key, entry);
}

export function recordSuccess(key: string) {
  store.delete(key);
}
