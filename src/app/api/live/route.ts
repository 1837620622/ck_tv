import { NextResponse } from 'next/server';

import { findLiveChannel } from '@/lib/live';

export const runtime = 'edge';

const PLAY_HOSTS = [
  'news.cctvplus.com',
  'cgtn.com',
  'myalicdn.com',
  'liveplay.myqcloud.com',
  'wscdns.com',
  'kcdnvip.com',
  'hrbtv.net',
  'hebtv.com',
  'lzr.com.cn',
  'sun0769.com',
  'jlntv.cn',
  'bread-tv.com',
  'abnvideos.com',
  'akamaized.net',
];

// 央视网页自己的 html5 接口。只拿清单地址，不拉视频分片。
const CNTV_PATHS = [
  'https://vdn.live.cntv.cn/api2/liveHtml5.do',
  'https://vdn.live.cntv.cn/api2/live.do',
];

function allowedPlayUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host.includes(':')) return null;
  const known = PLAY_HOSTS.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
  if (!known || !url.pathname.includes('.m3u8')) return null;
  return url.toString();
}

function readPayload(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!data || typeof data !== 'object') return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function uniquePaths(urls: string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const item of urls) {
    let path = '';
    try {
      path = new URL(item).pathname;
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    kept.push(item);
  }
  return kept;
}

function collect(payload: Record<string, unknown> | null): string[] {
  const hls = payload?.hls_url;
  if (!hls || typeof hls !== 'object') return [];
  const urls: string[] = [];
  for (const value of Object.values(hls as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const safe = allowedPlayUrl(value);
    if (safe) urls.push(safe);
  }
  return urls;
}

async function readCntv(endpoint: string, code: string): Promise<string[]> {
  // 频道号里的 pa:// 不能编码，编码后接口会当成不存在的频道。
  if (!/^pa:\/\/cctv_p2p_hd[a-z0-9]+$/.test(code)) return [];
  const url = `${endpoint}?channel=${code}&client=html5`;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://tv.cctv.com/',
      },
      signal: AbortSignal.timeout(6000),
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
    if (!response.ok) return [];
    return collect(readPayload(await response.text()));
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!/^[a-z0-9-]{1,32}$/.test(id)) {
    return NextResponse.json(
      { ok: false, urls: [] },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const channel = findLiveChannel(id);
  if (!channel || channel.kind === 'link') {
    return NextResponse.json(
      { ok: false, urls: [] },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  let urls = fresh
    ? []
    : (channel.urls || [])
        .map((item) => allowedPlayUrl(item))
        .filter((item): item is string => !!item);
  let kind = channel.kind;

  // fresh=1 跳过写死的清单，改向央视网页接口要一份新的。同一路径只留一条。
  if (urls.length === 0 && channel.code) {
    const batches = await Promise.all(
      CNTV_PATHS.map((endpoint) => readCntv(endpoint, channel.code as string))
    );
    const merged = uniquePaths(batches.flat());
    const video = merged.filter((item) => !item.includes('/audio/'));
    const audio = merged.filter((item) => item.includes('/audio/'));
    if (channel.kind !== 'audio' && video.length > 0) {
      urls = video.slice(0, 3);
      kind = 'video';
    } else {
      urls = audio.slice(0, 2);
      kind = 'audio';
    }
  }

  if (urls.length === 0) {
    return NextResponse.json(
      { ok: false, kind: channel.kind, urls: [] },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  return NextResponse.json(
    { ok: true, kind, urls },
    {
      headers: {
        'Cache-Control': 'no-store',
        'x-ck-cache': 'BYPASS',
      },
    }
  );
}
