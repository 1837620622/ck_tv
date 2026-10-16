import { NextResponse } from 'next/server';

import { huangguoPlayWhy, readHuangguoPlayTarget } from '@/lib/huangguo';
import { huangguoUpstreamPath } from '@/lib/huangguo-playlist';
import { readHuangguoPlaylist } from '@/lib/huangguo-socket';
import { gateDenyInit } from '@/lib/region-gate';

export const runtime = 'edge';

const NO_STORE = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'private, no-store',
};

function fail(status: number, why = '') {
  return new NextResponse(null, {
    status,
    headers: why ? { ...NO_STORE, 'x-ck-why': why } : NO_STORE,
  });
}

export async function GET(request: Request) {
  const denied = gateDenyInit(request);
  if (denied) {
    return NextResponse.json(denied.body, {
      status: denied.status,
      headers: denied.headers,
    });
  }
  const url = new URL(request.url);
  if (url.pathname !== '/api/huangguo/media/playlist.m3u8') return fail(404);
  const id = url.searchParams.get('id') || '';
  const episode = Number(url.searchParams.get('ep'));
  if (
    !/^\d{1,12}$/.test(id) ||
    !Number.isInteger(episode) ||
    episode < 1 ||
    episode > 9999
  ) {
    return fail(400);
  }

  try {
    // 电视要绝对地址。只在点投屏时走这条，正文里不带密钥。
    if (url.searchParams.get('format') === 'url') {
      const target = await readHuangguoPlayTarget(id, episode);
      if (!target) return fail(404, huangguoPlayWhy());
      return new NextResponse(JSON.stringify({ url: target }), {
        headers: {
          ...NO_STORE,
          'content-type': 'application/json; charset=utf-8',
        },
      });
    }

    // 浏览器跟随 302 时会带上本站 Origin，源站就把每一集收成同一份。
    // 这里用原始连接取回这一集的正文再交给播放器。分片地址仍是源站绝对地址。
    const target = await readHuangguoPlayTarget(id, episode);
    if (!target) return fail(404, huangguoPlayWhy());
    if (!huangguoUpstreamPath(target)) return fail(404, 'bad-host');
    const result = await readHuangguoPlaylist(target);
    if (!result.body) return fail(404, result.why || 'playlist-empty');
    return new NextResponse(result.body, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'CDN-Cache-Control': 'no-store',
        'content-type': 'application/vnd.apple.mpegurl',
      },
    });
  } catch {
    return fail(404);
  }
}
