import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { LIVE_CHANNELS, LiveChannel } from '@/lib/live';

export const runtime = 'edge';

const MAX_IDS = 25;
const CHECK_TIMEOUT_MS = 4000;
const CACHE_SECONDS = 600;
const BROWSER_SECONDS = 60;

interface Health {
  ok: boolean;
  reason?: string;
  ms?: number;
}

// 检查的是这条直播在部署环境里能不能被浏览器播放：
// 清单能拿到、内容是 HLS、并且允许本站跨域读取（hls.js 的请求是跨域带 Origin 的）。
async function checkChannel(
  channel: LiveChannel,
  origin: string
): Promise<Health> {
  const url = channel.urls?.[0];
  // 央视频道的地址在播放时现取，没有静态地址可检查，不算异常
  if (!url && channel.code) {
    return { ok: true, reason: 'dynamic' };
  }
  if (!url || !url.startsWith('https://')) {
    return { ok: false, reason: 'no-https' };
  }
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Accept: 'application/vnd.apple.mpegurl,*/*',
        Range: 'bytes=0-1023',
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}` };
    }
    // 只读开头一小段，不把整段直播流拉进来
    const reader = response.body?.getReader();
    let head = '';
    if (reader) {
      const { value } = await reader.read();
      head = value ? new TextDecoder().decode(value.subarray(0, 1024)) : '';
      await reader.cancel().catch(() => undefined);
    }
    if (!head.includes('#EXTM3U')) {
      return { ok: false, reason: 'not-manifest' };
    }
    const acao = response.headers.get('access-control-allow-origin');
    if (acao !== '*' && acao !== origin) {
      return { ok: false, reason: 'cors' };
    }
    return { ok: true, ms: Date.now() - started };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, reason: timedOut ? 'timeout' : 'network' };
  }
}

export async function GET(request: Request) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const { searchParams, origin } = new URL(request.url);
  // 只接受清单里已有的频道号，不接受外部传入的地址。
  // 先过滤、去重、排序再生成缓存键：同一组频道不管顺序如何都命中同一条缓存，无效 id 也不会写入缓存。
  const requested = (searchParams.get('ids') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);
  const channels = Array.from(new Set(requested))
    .map((id) => LIVE_CHANNELS.find((item) => item.id === id))
    .filter((item): item is LiveChannel => Boolean(item))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (channels.length === 0) {
    return NextResponse.json(
      { results: {} },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const cacheUrl = `https://cktv-cache.local/live-health?ids=${encodeURIComponent(
    channels.map((channel) => channel.id).join(',')
  )}&v=1`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    return new NextResponse(await hit.text(), {
      headers: {
        ...jsonCacheHeaders(CACHE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'HIT',
      },
    });
  }

  const checks = await Promise.all(
    channels.map(
      async (channel) =>
        [channel.id, await checkChannel(channel, origin)] as const
    )
  );
  const body = JSON.stringify({
    results: Object.fromEntries(checks),
    checkedAt: Date.now(),
  });
  writeJsonCache(ctx, cacheUrl, body, CACHE_SECONDS, BROWSER_SECONDS);
  return new NextResponse(body, {
    headers: {
      ...jsonCacheHeaders(CACHE_SECONDS, BROWSER_SECONDS),
      'content-type': 'application/json; charset=utf-8',
      'x-ck-cache': 'MISS',
    },
  });
}
