/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import {
  clientKey,
  lockedSeconds,
  recordFailure,
  recordSuccess,
} from '@/lib/throttle';
import { IStorage } from '@/lib/types';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  // 不支持 localstorage 模式
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储模式修改密码',
      },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { oldPassword, newPassword } = body;

    // 获取认证信息
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 验证新密码
    if (!newPassword || typeof newPassword !== 'string') {
      return NextResponse.json({ error: '新密码不得为空' }, { status: 400 });
    }
    if (newPassword.length > 128) {
      return NextResponse.json(
        { error: '密码不能超过 128 个字符' },
        { status: 400 }
      );
    }

    const username = authInfo.username;

    // 不允许站长修改密码（站长用户名等于 process.env.USERNAME）
    if (username === process.env.USERNAME) {
      return NextResponse.json(
        { error: '站长不能通过此接口修改密码' },
        { status: 403 }
      );
    }

    // 获取存储实例
    const storage: IStorage | null = getStorage();
    if (!storage || typeof storage.changePassword !== 'function') {
      return NextResponse.json(
        { error: '存储服务不支持修改密码' },
        { status: 500 }
      );
    }

    // 必须先验证当前密码：偷到 Cookie 的人不能直接改密。连续输错同样会被限制。
    if (typeof oldPassword !== 'string' || !oldPassword) {
      return NextResponse.json({ error: '请输入当前密码' }, { status: 400 });
    }
    const throttleKey = clientKey(request, username);
    const wait = lockedSeconds(throttleKey);
    if (wait > 0) {
      return NextResponse.json(
        { error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` },
        { status: 429, headers: { 'Retry-After': String(wait) } }
      );
    }
    if (!(await storage.verifyUser(username, oldPassword))) {
      recordFailure(throttleKey);
      return NextResponse.json({ error: '当前密码错误' }, { status: 401 });
    }
    recordSuccess(throttleKey);

    // 修改密码
    await storage.changePassword(username, newPassword);

    return NextResponse.json({ ok: true });
  } catch (error) {
    // 不把底层报错回显给客户端，原文只写服务端日志
    console.error('修改密码失败:', error);
    return NextResponse.json({ error: '修改密码失败' }, { status: 500 });
  }
}
