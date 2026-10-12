/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie, LOCAL_AUTH_SUBJECT } from '@/lib/auth';
import { verifyHmacHex } from '@/lib/crypto';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 跳过不需要认证的路径
  if (shouldSkipAuth(pathname)) {
    return NextResponse.next();
  }

  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  // 如果没有设置密码，直接放行
  if (storageType === 'localstorage' && !process.env.PASSWORD) {
    return NextResponse.next();
  }

  //if (!process.env.PASSWORD) {
  // 如果没有设置密码，重定向到警告页面
  //  const warningUrl = new URL('/warning', request.url);
  //  return NextResponse.redirect(warningUrl);
  //}

  // 从cookie获取认证信息
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo || !authInfo.signature) {
    return handleAuthFailure(request, pathname);
  }

  const secret = process.env.PASSWORD || '';

  // localstorage 模式：Cookie 里只有对固定标记的签名，不含口令
  if (storageType === 'localstorage') {
    const valid = await verifyHmacHex(
      LOCAL_AUTH_SUBJECT,
      authInfo.signature,
      secret
    );
    return valid ? NextResponse.next() : handleAuthFailure(request, pathname);
  }

  // 其他模式：签名对象是用户名
  if (!authInfo.username) {
    return handleAuthFailure(request, pathname);
  }
  const valid = await verifyHmacHex(
    authInfo.username,
    authInfo.signature,
    secret
  );
  return valid ? NextResponse.next() : handleAuthFailure(request, pathname);
}

// 处理认证失败的情况
function handleAuthFailure(
  request: NextRequest,
  pathname: string
): NextResponse {
  // 如果是 API 路由，返回 401 状态码
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // 否则重定向到登录页面
  const loginUrl = new URL('/login', request.url);
  // 保留完整的URL，包括查询参数
  const fullUrl = `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set('redirect', fullUrl);
  return NextResponse.redirect(loginUrl);
}

// 判断是否需要跳过认证的路径
function shouldSkipAuth(pathname: string): boolean {
  const skipPaths = [
    '/_next',
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/icons/',
    '/logo.png',
    '/screenshot.png',
  ];

  return skipPaths.some((path) => pathname.startsWith(path));
}

// 配置middleware匹配规则
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/register|api/logout|api/cron|api/server-config).*)',
  ],
};
