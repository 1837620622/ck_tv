/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie, LOCAL_AUTH_SUBJECT } from '@/lib/auth';
import { DEFAULT_JSON_BODY_BYTES, readJsonBody } from '@/lib/body';
import { db, hasServerStorage } from '@/lib/db';

export const runtime = 'edge';

// 最大保存条数（与客户端保持一致）
const HISTORY_LIMIT = 20;

/**
 * GET /api/searchhistory
 * 返回 string[]
 */
export async function GET(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const history = await db.getSearchHistory(LOCAL_AUTH_SUBJECT);
    return NextResponse.json(history, { status: 200 });
  } catch (err) {
    console.error('获取搜索历史失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/searchhistory
 * body: { keyword: string }
 */
export async function POST(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = await readJsonBody(request, DEFAULT_JSON_BODY_BYTES);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: parsed.status }
      );
    }
    // 非字符串的 keyword 直接当成空，返回 400，而不是在 .trim() 上抛异常变成 500
    const raw = (parsed.data as { keyword?: unknown } | null)?.keyword;
    const keyword = typeof raw === 'string' ? raw.trim() : '';

    if (!keyword) {
      return NextResponse.json(
        { error: 'Keyword is required' },
        { status: 400 }
      );
    }

    await db.addSearchHistory(LOCAL_AUTH_SUBJECT, keyword);

    // 再次获取最新列表，确保客户端与服务端同步
    const history = await db.getSearchHistory(LOCAL_AUTH_SUBJECT);
    return NextResponse.json(history.slice(0, HISTORY_LIMIT), { status: 200 });
  } catch (err) {
    console.error('添加搜索历史失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/searchhistory?keyword=<kw>
 *
 * 1. 不带 keyword -> 清空全部搜索历史
 * 2. 带 keyword=<kw> -> 删除单条关键字
 */
export async function DELETE(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const kw = searchParams.get('keyword')?.trim();

    await db.deleteSearchHistory(LOCAL_AUTH_SUBJECT, kw || undefined);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('删除搜索历史失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
