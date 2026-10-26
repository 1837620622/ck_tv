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
// 列表在边缘留一刻钟。过了新鲜期只在后台回源，这次点击直接交已有结果，避免搜索卡住。
export function lineBudget(line: LineMode) {
  const cache = {
    edgeSeconds: 900,
    browserSeconds: 60,
    freshSeconds: 600,
    waitStaleMs: 0,
  };
  if (line === 'cn') {
    return {
      ...cache,
      deadlineMs: 900,
      fastCount: 8,
      timeoutMs: 1800,
    };
  }
  return {
    ...cache,
    deadlineMs: 1200,
    fastCount: 12,
    timeoutMs: 2200,
  };
}
