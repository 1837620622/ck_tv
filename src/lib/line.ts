export type LineMode = 'cn' | 'global';

export interface RankedSite {
  priority?: number;
  globalPriority?: number;
  region?: string;
}

// Cloudflare 边缘会带上 CF-IPCountry。国内走国内优先顺序，其余国家走海外节点优先。
export function viewerLine(request: Request): LineMode {
  const country = (
    request.headers.get('cf-ipcountry') ||
    request.headers.get('CF-IPCountry') ||
    ''
  ).toUpperCase();

  if (!country || country === 'CN' || country === 'XX' || country === 'T1') {
    return 'cn';
  }
  return 'global';
}

export function sourceRank(site: RankedSite, line: LineMode): number {
  if (line === 'global') {
    return site.globalPriority ?? site.priority ?? 100;
  }
  return site.priority ?? 100;
}
