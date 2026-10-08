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

// 国内出口先只等最靠前的一批国内源，页面先出来，其余源在后台补进边缘缓存。
export function lineBudget(line: LineMode) {
  if (line === 'cn') {
    return {
      edgeSeconds: 1800,
      browserSeconds: 90,
      freshSeconds: 300,
      deadlineMs: 900,
      fastCount: 8,
      timeoutMs: 1800,
    };
  }
  return {
    edgeSeconds: 600,
    browserSeconds: 30,
    freshSeconds: 120,
    deadlineMs: 1200,
    fastCount: 12,
    timeoutMs: 2200,
  };
}
