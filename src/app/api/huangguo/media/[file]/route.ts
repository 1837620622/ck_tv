import { NextResponse } from 'next/server';

import { huangguoPlayWhy, readHuangguoPlayTarget } from '@/lib/huangguo';

export const runtime = 'edge';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(status: number, why = '') {
  return new NextResponse(null, {
    status,
    headers: why ? { ...NO_STORE, 'x-ck-why': why } : NO_STORE,
  });
}

export async function GET(request: Request) {
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

    // 边缘缓存曾把不同集的清单收成同一份。这里只跳到刚拿到的地址，正文由浏览器直连源站。
    const target = await readHuangguoPlayTarget(id, episode);
    if (!target) return fail(404, huangguoPlayWhy());
    return new NextResponse(null, {
      status: 302,
      headers: {
        Location: target,
        'Cache-Control': 'no-store, max-age=0',
        'CDN-Cache-Control': 'no-store',
      },
    });
  } catch {
    return fail(404);
  }
}
