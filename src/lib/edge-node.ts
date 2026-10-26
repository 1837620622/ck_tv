// 访客当前连到的 Cloudflare 节点。
// Cloudflare 在每个接入它的域名下都提供 /cdn-cgi/trace，由边缘节点直接回答，不经过本站的函数，
// 返回若干行 key=value，其中 colo 是节点的机场代码，loc 是访客所在国家。

export type EdgeNode = {
  colo: string;
  country: string;
};

// 常见节点的中文名。不在表里的直接显示代码。
const COLO_NAMES: Record<string, string> = {
  HKG: '香港',
  TPE: '台北',
  KHH: '高雄',
  MFM: '澳门',
  NRT: '东京',
  HND: '东京',
  KIX: '大阪',
  FUK: '福冈',
  ICN: '首尔',
  SIN: '新加坡',
  KUL: '吉隆坡',
  BKK: '曼谷',
  MNL: '马尼拉',
  SGN: '胡志明市',
  HAN: '河内',
  BOM: '孟买',
  DEL: '新德里',
  SYD: '悉尼',
  MEL: '墨尔本',
  LAX: '洛杉矶',
  SJC: '圣何塞',
  SFO: '旧金山',
  SEA: '西雅图',
  PDX: '波特兰',
  DFW: '达拉斯',
  ORD: '芝加哥',
  IAD: '华盛顿',
  EWR: '纽瓦克',
  JFK: '纽约',
  MIA: '迈阿密',
  YVR: '温哥华',
  YYZ: '多伦多',
  LHR: '伦敦',
  CDG: '巴黎',
  FRA: '法兰克福',
  AMS: '阿姆斯特丹',
  MAD: '马德里',
  MXP: '米兰',
  ARN: '斯德哥尔摩',
  WAW: '华沙',
  DXB: '迪拜',
};

export function parseTrace(text: string): EdgeNode | null {
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const colo = (fields.colo || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(colo)) return null;
  const country = (fields.loc || '').toUpperCase();
  return { colo, country: /^[A-Z]{2}$/.test(country) ? country : '' };
}

export function coloName(colo: string): string {
  const name = COLO_NAMES[colo.toUpperCase()];
  return name ? `${name} ${colo.toUpperCase()}` : colo.toUpperCase();
}

// 本地开发和 Docker 没有 /cdn-cgi/trace，返回 null，界面就不显示。
export async function fetchEdgeNode(
  timeoutMs = 5000
): Promise<EdgeNode | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('/cdn-cgi/trace', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseTrace(await response.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
