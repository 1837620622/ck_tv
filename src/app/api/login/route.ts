/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { LOCAL_AUTH_SUBJECT } from '@/lib/auth';
import { readJsonBody } from '@/lib/body';
import { hmacHex, safeEqual } from '@/lib/crypto';
import { isHttpsRequest } from '@/lib/https';
import { beginAttempt, clientKey, recordSuccess } from '@/lib/throttle';

export const runtime = 'edge';

// 站点只有一个口令，所有登录尝试共用同一个限流账号
const THROTTLE_ACCOUNT = 'site';

// 登录请求体只有一个口令字段。这是未认证接口，上限要小，免得被大包体撑爆内存
const MAX_LOGIN_BODY_BYTES = 4 * 1024;

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'd1'
    | 'upstash'
    | undefined) || 'localstorage';

// 连续输错口令后暂时拒绝，避免在线暴力破解
function tooManyAttempts(seconds: number) {
  return NextResponse.json(
    { error: `尝试次数过多，请 ${Math.ceil(seconds / 60)} 分钟后再试` },
    { status: 429, headers: { 'Retry-After': String(seconds) } }
  );
}

// 认证 Cookie 只放签名，不放口令
async function generateAuthCookie(): Promise<string> {
  const signature = await hmacHex(
    LOCAL_AUTH_SUBJECT,
    process.env.PASSWORD || ''
  );
  return encodeURIComponent(JSON.stringify({ signature }));
}

export async function POST(req: NextRequest) {
  try {
    const envPassword = process.env.PASSWORD;

    // 未配置 PASSWORD
    if (!envPassword) {
      if (STORAGE_TYPE !== 'localstorage') {
        return NextResponse.json(
          { error: '服务器未设置 PASSWORD' },
          { status: 500 }
        );
      }
      const response = NextResponse.json({ ok: true });

      // 清除可能存在的认证cookie
      response.cookies.set('auth', '', {
        path: '/',
        expires: new Date(0),
        sameSite: 'lax', // 改为 lax 以支持 PWA
        httpOnly: false, // PWA 需要客户端可访问
        secure: isHttpsRequest(req),
      });

      return response;
    }

    // 先计数再读取请求体，并发请求不能各自绕过上限
    const key = clientKey(req, THROTTLE_ACCOUNT);
    const wait = beginAttempt(key);
    if (wait > 0) return tooManyAttempts(wait);

    const parsed = await readJsonBody(req, MAX_LOGIN_BODY_BYTES);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: parsed.status }
      );
    }
    const password = (parsed.data as { password?: unknown } | null)?.password;
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }

    if (!safeEqual(password, envPassword)) {
      return NextResponse.json(
        { ok: false, error: '密码错误' },
        { status: 401 }
      );
    }

    // 验证成功，设置认证cookie
    recordSuccess(key);
    const response = NextResponse.json({ ok: true });
    const cookieValue = await generateAuthCookie();
    const expires = new Date();
    expires.setDate(expires.getDate() + 7); // 7天过期

    response.cookies.set('auth', cookieValue, {
      path: '/',
      expires,
      sameSite: 'lax', // 改为 lax 以支持 PWA
      httpOnly: false, // PWA 需要客户端可访问
      secure: isHttpsRequest(req),
    });

    return response;
  } catch (error) {
    console.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
