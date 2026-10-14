/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AUTH_COOKIE, verifyAuthCookieValue } from '@/lib/auth-token';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 跳过不需要认证的路径
  if (shouldSkipAuth(pathname)) {
    return NextResponse.next();
  }

  const secret = process.env.PASSWORD || '';
  if (!secret) {
    // 未设置口令：只有本地存储模式放行；数据库模式不能在没有口令的情况下公开访问
    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
    return storageType === 'localstorage'
      ? NextResponse.next()
      : handleAuthFailure(request, pathname);
  }

  // 认证 Cookie 必须是未过期、签名正确的 v2 令牌（旧格式的 Cookie 一律视为未登录）
  const valid = await verifyAuthCookieValue(
    request.cookies.get(AUTH_COOKIE)?.value
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
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/logout|api/cron|api/server-config).*)',
  ],
};
