import { NextRequest, NextResponse } from 'next/server';

import { isHttpsRequest } from '@/lib/https';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const response = NextResponse.json({ ok: true });

  // 清除认证cookie
  response.cookies.set('auth', '', {
    path: '/',
    expires: new Date(0),
    sameSite: 'lax',
    httpOnly: false,
    secure: isHttpsRequest(req),
  });

  return response;
}
