import { countryOf } from '@/lib/edge-country';

export type LineMode = 'cn' | 'global';

export interface RankedSite {
  priority?: number;
  globalPriority?: number;
  region?: string;
}

// 线路只看平台给出的国家。调用方自己带的 CF-IPCountry 不能把国内请求改成海外源。
// 拿不到国家时按国内线路，和门控一样不信空头。
export function viewerLine(request: Request): LineMode {
  const country = countryOf(request);
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
// 新鲜期过了就在这次搜索里多等一会儿，把新集数带回页面，而不是继续交旧列表。
export function lineBudget(line: LineMode) {
  if (line === 'cn') {
    return {
      edgeSeconds: 40,
      browserSeconds: 10,
      freshSeconds: 20,
      waitStaleMs: 700,
      deadlineMs: 900,
      fastCount: 8,
      timeoutMs: 1800,
    };
  }
  return {
    edgeSeconds: 30,
    browserSeconds: 10,
    freshSeconds: 15,
    waitStaleMs: 800,
    deadlineMs: 1200,
    fastCount: 12,
    timeoutMs: 2200,
  };
}
