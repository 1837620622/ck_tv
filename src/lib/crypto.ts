// 只用 Web Crypto，边缘运行时和 Node 都能跑。

const encoder = new TextEncoder();

// PBKDF2 迭代次数。Pages Functions 免费档 CPU 预算只有 10ms，
// 这里取 1 万次（本机约 4ms）。迭代数写在哈希串里，之后调高只影响新口令。
const PBKDF2_ITERATIONS = 10_000;
const PBKDF2_PREFIX = 'pbkdf2-sha256';

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// 等长字符串逐位比较，不因为先出现的差异而提前返回
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    diff |= x[i] ^ y[i];
  }
  return diff === 0;
}

async function hmacKey(
  secret: string,
  usage: 'sign' | 'verify'
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

// 用站点密钥对一段文本做 HMAC-SHA256，返回十六进制串
export async function hmacHex(data: string, secret: string): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}

// 校验 hmacHex 生成的签名。密钥为空或签名格式不对直接判失败。
export async function verifyHmacHex(
  data: string,
  signatureHex: string,
  secret: string
): Promise<boolean> {
  const signature = fromHex(signatureHex);
  if (!signature || !secret) return false;
  try {
    const key = await hmacKey(secret, 'verify');
    return await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(data)
    );
  } catch {
    return false;
  }
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    256
  );
}

// 生成口令哈希，格式：pbkdf2-sha256$迭代数$盐$哈希
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

// 校验口令。库里还是旧版明文时也能比对，并通过 legacy 告诉调用方该升级成哈希。
export async function checkPassword(
  password: string,
  stored: string
): Promise<{ ok: boolean; legacy: boolean }> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) {
    return { ok: safeEqual(password, stored), legacy: true };
  }

  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || !salt) {
    return { ok: false, legacy: false };
  }
  const actual = toHex(await pbkdf2(password, salt, iterations));
  return { ok: safeEqual(actual, parts[3]), legacy: false };
}
