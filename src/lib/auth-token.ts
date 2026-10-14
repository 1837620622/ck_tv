// 站点口令登录后发给浏览器的认证 Cookie（v2 格式）：
//   {"v":2,"iat":<签发时间，毫秒>,"signature":"<HMAC-SHA256 十六进制>"}
// 签名内容是 `localstorage|v2|<iat>`，密钥优先用 AUTH_SECRET。
// - 密钥与口令分开：持有 Cookie 的人拿不到可以离线比对口令的确定性结果。
//   未设置 AUTH_SECRET 时退回到 PASSWORD，老部署不会被锁在外面，但这时仍有离线猜口令的风险，
//   应尽快配置 AUTH_SECRET。
// - iat 参与签名，服务端强制 7 天过期，不只靠浏览器删 Cookie。
import { LOCAL_AUTH_SUBJECT } from '@/lib/auth';
import { hmacHex, verifyHmacHex } from '@/lib/crypto';

export const AUTH_COOKIE = 'auth';
export const AUTH_TOKEN_VERSION = 2;
export const AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// 允许服务器与浏览器之间有一点时钟偏差，但签发时间不能在未来太远
const CLOCK_SKEW_MS = 60 * 1000;

function signingKey(): string {
  return process.env.AUTH_SECRET || process.env.PASSWORD || '';
}

function signedMessage(iat: number): string {
  return `${LOCAL_AUTH_SUBJECT}|v${AUTH_TOKEN_VERSION}|${iat}`;
}

// 生成 Cookie 的值（已做 URL 编码，和浏览器里存的一致）
export async function createAuthCookieValue(
  now: number = Date.now()
): Promise<string> {
  const signature = await hmacHex(signedMessage(now), signingKey());
  return encodeURIComponent(
    JSON.stringify({ v: AUTH_TOKEN_VERSION, iat: now, signature })
  );
}

// 校验 Cookie 的值：格式、版本、签名与有效期都要通过
export async function verifyAuthCookieValue(
  raw: string | undefined,
  now: number = Date.now()
): Promise<boolean> {
  if (!raw) return false;
  let data: unknown;
  try {
    data = JSON.parse(decodeURIComponent(raw));
  } catch {
    return false;
  }
  if (typeof data !== 'object' || data === null) return false;
  const { v, iat, signature } = data as Record<string, unknown>;
  if (
    v !== AUTH_TOKEN_VERSION ||
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    typeof signature !== 'string'
  ) {
    return false;
  }
  const age = now - iat;
  if (age < -CLOCK_SKEW_MS || age > AUTH_MAX_AGE_MS) return false;
  return verifyHmacHex(signedMessage(iat), signature, signingKey());
}
