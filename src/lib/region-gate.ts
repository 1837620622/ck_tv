// 栏目口令。只在边缘核对，页面上不展示。
const GATE_CODE = 'chuankangkk';

export const GATE_COOKIE = 'cktv-gate';

// 通过口令后写入的会话标记。和口令本身不是同一串。
export const GATE_TOKEN = 'b7e1c4a09d6f4e2a8c5d17f03b6a9e84';

// 中国大陆、香港、台湾。代码来自 Cloudflare 的国家字段，不看访客自己填的地区。
const BLOCKED_COUNTRIES = new Set(['CN', 'HK', 'TW']);

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

// 只认 Cloudflare 写入的国家。平台值和 request.cf 存在时，不再看调用方自己带的头。
// 空值、未知码一律不算国外。
export function countryOf(request: CfRequest): string {
  const fromContext = platformCountry();
  if (fromContext !== undefined) return fromContext;
  if (request.cf) {
    return (request.cf.country || '').trim().toUpperCase();
  }
  return (request.headers?.get('cf-ipcountry') || '').trim().toUpperCase();
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

function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

export function gateOpen(request: CfRequest): boolean {
  if (!isForeignCountry(countryOf(request))) return false;
  const token = readCookie(request.headers?.get('cookie') || null, GATE_COOKIE);
  return sameText(token, GATE_TOKEN);
}

export function passwordMatches(code: string): boolean {
  return sameText(code.trim().toLowerCase(), GATE_CODE);
}

// 地区不对是 region，口令不对是 gate。通过时返回 null。
export function gateDenial(request: CfRequest): 'region' | 'gate' | null {
  if (!isForeignCountry(countryOf(request))) return 'region';
  return gateOpen(request) ? null : 'gate';
}

export function gateDenyInit(request: CfRequest): {
  body: { error: 'region' | 'gate' };
  status: 403;
  headers: Record<string, string>;
} | null {
  const why = gateDenial(request);
  if (!why) return null;
  return {
    body: { error: why },
    status: 403,
    headers: { ...PRIVATE_HEADERS, 'x-ck-why': why },
  };
}
