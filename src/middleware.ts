import { NextResponse } from 'next/server';

import { FRAMING_HEADERS } from '@/lib/framing';

// 页面和接口都加防嵌入头。静态资源不经过这里，见下面的 matcher。
export function middleware() {
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(FRAMING_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|icons/|logo\\.png|favicon\\.ico|sw\\.js).*)',
  ],
};
