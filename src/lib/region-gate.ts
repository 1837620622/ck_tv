// 栏目门控：地区 + 口令。
// - 地区只认平台给出的国家（Pages 的平台上下文，或 Worker 的 request.cf）。
//   自己用 Node/Docker 部署时两者都没有；只有部署者确认前面的 Cloudflare 会覆盖 CF-IPCountry，
//   才设 GATE_TRUST_COUNTRY_HEADER=true 去读那个头。
// - 口令和签名密钥只从环境变量读取（GATE_PASSWORD、GATE_SECRET），不写进源码。
// - 通过口令后发的 cookie 是「签发时间.HMAC 签名」，服务端每次校验，7 天后失效。
// 任何一项没配置，门控都是关着的。

export const GATE_COOKIE = 'cktv-gate';

// 通过口令后的有效期：7 天
export const GATE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// 签发时间比服务器时间快出的秒数上限，超过的按伪造处理
const CLOCK_SKEW_SECONDS = 300;

// 中国大陆、香港、澳门、台湾
const BLOCKED_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW']);

export const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'private, no-store',
};

type CfRequest = {
  cf?: { country?: string };
  headers?: { get(name: string): string | null };
};

// next-on-pages 把原始请求的 cf 放在这个符号上。页面拿到的 Request 往往没有 cf。
const PLATFORM_CONTEXT = Symbol.for('__cloudflare-request-context__');

type PlatformContext = {
  cf?: { country?: unknown };
};

// 边缘运行时才有这份上下文。读不到时返回 undefined，交给后面的字段。
function platformCountry(): string | undefined {
  try {
    const ctx = (
      globalThis as unknown as Record<symbol, PlatformContext | undefined>
    )[PLATFORM_CONTEXT];
    if (!ctx?.cf) return undefined;
    if (typeof ctx.cf.country !== 'string') return '';
    return ctx.cf.country.trim().toUpperCase();
  } catch {
    return undefined;
  }
}

// CF-IPCountry 是访客自己也能发的头，默认不信任。
function trustCountryHeader(): boolean {
  return process.env.GATE_TRUST_COUNTRY_HEADER === 'true';
}

// 空值、未知码一律不算国外（见 isForeignCountry）。
export function countryOf(request: CfRequest): string {
  const fromContext = platformCountry();
  if (fromContext !== undefined) return fromContext;
  if (request.cf) {
    return (request.cf.country || '').trim().toUpperCase();
  }
  if (trustCountryHeader()) {
    return (request.headers?.get('cf-ipcountry') || '').trim().toUpperCase();
  }
  return '';
}

export function isForeignCountry(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  if (code === 'XX' || code === 'T1') return false;
  return !BLOCKED_COUNTRIES.has(code);
}

function readCookie(header: string | null, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    try {
      return decodeURIComponent(trimmed.slice(eq + 1));
    } catch {
      return '';
    }
  }
  return '';
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

// 先各自做 SHA-256 再逐位比较：两边长度不同也走完整比较，不会因为内容或长度提前返回。
async function sameSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) {
    diff |= x[i] ^ y[i];
  }
  return diff === 0;
}

function configuredPassword(): string {
  return (process.env.GATE_PASSWORD || '').trim().toLowerCase();
}

// 少于 32 个字符的密钥不用：签名密钥太短，cookie 就能被离线猜出来。
function configuredSecret(): string {
  const secret = (process.env.GATE_SECRET || '').trim();
  return secret.length >= 32 ? secret : '';
}

// 配置缺了什么，给人看的说明；全部配好时返回空数组。
export function gateConfigProblems(): string[] {
  const problems: string[] = [];
  if (configuredPassword() === '') {
    problems.push('GATE_PASSWORD 没有设置');
  }
  if (configuredSecret() === '') {
    problems.push('GATE_SECRET 没有设置，或者少于 32 个字符');
  }
  return problems;
}

// 口令和签名密钥都配好了，门控才会工作。
export function gateConfigured(): boolean {
  return gateConfigProblems().length === 0;
}

async function sign(message: string): Promise<string> {
  const secret = configuredSecret();
  if (!secret) return '';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(new Uint8Array(mac));
}

export async function passwordMatches(code: string): Promise<boolean> {
  const expected = configuredPassword();
  if (!expected) return false;
  return sameSecret(code.trim().toLowerCase(), expected);
}

// 签发 cookie 的值：「签发时间（秒）.签名」。口令本身不进 cookie。
// 没配签名密钥时返回 null。
export async function issueGateCookie(
  now: number = Date.now()
): Promise<string | null> {
  const iat = Math.floor(now / 1000);
  const mac = await sign(`${GATE_COOKIE}:${iat}`);
  return mac ? `${iat}.${mac}` : null;
}

async function validGateCookie(value: string, now: number): Promise<boolean> {
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const issued = value.slice(0, dot);
  if (!/^\d{1,12}$/.test(issued)) return false;
  const iat = Number(issued);
  const age = Math.floor(now / 1000) - iat;
  if (age < -CLOCK_SKEW_SECONDS || age > GATE_MAX_AGE_SECONDS) return false;
  const expected = await sign(`${GATE_COOKIE}:${iat}`);
  if (!expected) return false;
  return sameSecret(value.slice(dot + 1), expected);
}

// 地区符合且 cookie 有效。地区不符时不看 cookie。
export async function gateOpen(
  request: CfRequest,
  now: number = Date.now()
): Promise<boolean> {
  if (!isForeignCountry(countryOf(request))) return false;
  const token = readCookie(request.headers?.get('cookie') || null, GATE_COOKIE);
  if (!token) return false;
  return validGateCookie(token, now);
}

// 地区不对是 region，口令或 cookie 不对是 gate。通过时返回 null。
export async function gateDenial(
  request: CfRequest
): Promise<'region' | 'gate' | null> {
  if (!isForeignCountry(countryOf(request))) return 'region';
  return (await gateOpen(request)) ? null : 'gate';
}

export async function gateDenyInit(request: CfRequest): Promise<{
  body: { error: 'region' | 'gate' };
  status: 403;
  headers: Record<string, string>;
} | null> {
  const why = await gateDenial(request);
  if (!why) return null;
  return {
    body: { error: why },
    status: 403,
    headers: { ...PRIVATE_HEADERS, 'x-ck-why': why },
  };
}
