// 只用 Web Crypto，边缘运行时和 Node 都能跑。

const encoder = new TextEncoder();

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
