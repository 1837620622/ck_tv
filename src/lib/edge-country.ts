// 访客国家只认平台给出的值。CF-IPCountry 调用方自己也能带，默认不信。

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

// 只有部署者确认前面的 Cloudflare 会覆盖这个头，才允许读它。
function trustCountryHeader(): boolean {
  return process.env.GATE_TRUST_COUNTRY_HEADER === 'true';
}

// 空值、未知码由调用方决定怎么处理。
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
