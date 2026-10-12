import { getOptionalRequestContext } from '@cloudflare/next-on-pages';

// 口令尝试次数限制：按“客户端 IP + 账号”计数，达到上限后锁定一段时间。
// 每次尝试在校验口令之前同步计数，所以并发请求不能各自绕过上限；校验成功后清除记录。
// 状态只存在当前实例的内存里。Cloudflare 上每个实例各算各的，Docker 单进程则是全局的。
// 它挡的是单机的暴力尝试，不是分布式限流；要更严格需要在 WAF 上加速率规则或共享存储。

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_KEYS = 5000;
const MAX_ACCOUNT_LENGTH = 64;

interface Entry {
  // 本窗口内的尝试次数，每次尝试都计数，成功后整条记录会被清除
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

const store = new Map<string, Entry>();

function onCloudflare(): boolean {
  try {
    return Boolean(getOptionalRequestContext());
  } catch {
    return false;
  }
}

// 客户端 IP 只从可信来源取：
// - Cloudflare 上 cf-connecting-ip 由边缘覆盖，客户端填的值会被替换；
// - 自建部署前面若有一层会追加 X-Forwarded-For 的反代，设置 TRUST_PROXY=true 后取最右一段。
// 其它情况（比如直连 Docker 端口）客户端可以随意填头，不能用来分桶，返回 null。
function clientIp(request: Request): string | null {
  if (onCloudflare()) {
    return request.headers.get('cf-connecting-ip')?.trim() || null;
  }
  if (process.env.TRUST_PROXY === 'true') {
    const hops = (request.headers.get('x-forwarded-for') || '')
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    return hops[hops.length - 1] || null;
  }
  return null;
}

export function clientKey(request: Request, account: string): string {
  // 拿不到可信 IP 时所有客户端共用同一个账号桶，代价是陌生人也能让某账号暂时被锁。
  // 直连部署请设置 TRUST_PROXY 或放到 Cloudflare 后面来避免这一点。
  const ip = clientIp(request) || 'anon';
  return `${ip}|${account.toLowerCase().slice(0, MAX_ACCOUNT_LENGTH)}`;
}

// 表满时先清掉已过期的记录；仍然满，就从最早的记录开始淘汰未锁定的，绝不动正在锁定的。
function makeRoom(now: number) {
  store.forEach((entry, key) => {
    if (entry.lockedUntil <= now && now - entry.firstAt > WINDOW_MS) {
      store.delete(key);
    }
  });
  for (const key of Array.from(store.keys())) {
    if (store.size < MAX_KEYS) break;
    const entry = store.get(key);
    if (entry && entry.lockedUntil <= now) store.delete(key);
  }
}

// 校验口令之前调用：同步完成“检查是否锁定 + 计数”。
// 返回还要等多少秒才能再试，0 表示可以继续校验。
export function beginAttempt(key: string, now = Date.now()): number {
  let entry = store.get(key);
  if (entry && entry.lockedUntil > now) {
    return Math.ceil((entry.lockedUntil - now) / 1000);
  }
  // 窗口已过，或锁定已结束（锁定时长大于窗口，所以锁定结束时窗口必然已过）：重新计数
  if (entry && now - entry.firstAt > WINDOW_MS) {
    store.delete(key);
    entry = undefined;
  }
  if (!entry) {
    if (store.size >= MAX_KEYS) makeRoom(now);
    // 表里全是锁定中的记录时拒绝新来源，宁可误伤也不放行
    if (store.size >= MAX_KEYS) return Math.ceil(LOCK_MS / 1000);
    entry = { failures: 0, firstAt: now, lockedUntil: 0 };
    store.set(key, entry);
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCK_MS;
  }
  return 0;
}

// 校验成功后调用，清掉该来源的计数
export function recordSuccess(key: string) {
  store.delete(key);
}
