import { NextResponse } from 'next/server';

import {
  allowedCoverUrl,
  coverContentType,
  decryptHuangguoCover,
} from '@/lib/huangguo-image';

export const runtime = 'edge';

export async function GET(request: Request) {
  const target = allowedCoverUrl(
    new URL(request.url).searchParams.get('u') || ''
  );
  if (!target) {
    return NextResponse.json({ error: '封面地址无效' }, { status: 400 });
  }

  try {
    const response = await fetch(target, {
      headers: {
        Accept: 'image/*,*/*',
        Referer: 'https://huangguoai.com/',
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      },
      cache: 'no-store',
    });
    if (!response.ok) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const image = decryptHuangguoCover(bytes);
    const type = image ? coverContentType(image) : '';
    if (!image || !type) {
      return new NextResponse(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return new NextResponse(new Blob([image]), {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse(null, {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
