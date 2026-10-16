/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { LOCAL_AUTH_SUBJECT } from '@/lib/auth';
import { DEFAULT_JSON_BODY_BYTES, readJsonBody } from '@/lib/body';
import { db, hasServerStorage } from '@/lib/db';
import { gateDenial } from '@/lib/region-gate';
import { Favorite } from '@/lib/types';
import { isAdultSource } from '@/lib/yellow';

export const runtime = 'edge';

/**
 * GET /api/favorites
 *
 * 支持两种调用方式：
 * 1. 不带 query，返回全部收藏列表（Record<string, Favorite>）。
 * 2. 带 key=source+id，返回单条收藏（Favorite | null）。
 */
export async function GET(request: NextRequest) {
  try {
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    // 查询单条收藏
    if (key) {
      const [source, id] = key.split('+');
      if (!source || !id) {
        return NextResponse.json(
          { error: 'Invalid key format' },
          { status: 400 }
        );
      }
      const fav = await db.getFavorite(LOCAL_AUTH_SUBJECT, source, id);
      // 没通过门控时，成人源和黄果的收藏当作不存在
      if (
        fav &&
        isAdultSource({ key: source }) &&
        (await gateDenial(request)) !== null
      ) {
        return NextResponse.json(null, { status: 200 });
      }
      return NextResponse.json(fav, { status: 200 });
    }

    // 查询全部收藏；没通过门控的访客看不到成人源和黄果的收藏
    const favorites = await db.getAllFavorites(LOCAL_AUTH_SUBJECT);
    if ((await gateDenial(request)) === null) {
      return NextResponse.json(favorites, { status: 200 });
    }
    const visible = Object.fromEntries(
      Object.entries(favorites).filter(
        ([favKey]) => !isAdultSource({ key: favKey.split('+')[0] })
      )
    );
    return NextResponse.json(visible, { status: 200 });
  } catch (err) {
    console.error('获取收藏失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/favorites
 * body: { key: string; favorite: Favorite }
 */
export async function POST(request: NextRequest) {
  try {
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }

    const parsed = await readJsonBody(request, DEFAULT_JSON_BODY_BYTES);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: parsed.status }
      );
    }
    const { key, favorite } = parsed.data as {
      key: string;
      favorite: Favorite;
    };

    if (!key || !favorite) {
      return NextResponse.json(
        { error: 'Missing key or favorite' },
        { status: 400 }
      );
    }

    // 验证必要字段
    if (!favorite.title || !favorite.source_name) {
      return NextResponse.json(
        { error: 'Invalid favorite data' },
        { status: 400 }
      );
    }

    const [source, id] = key.split('+');
    if (!source || !id) {
      return NextResponse.json(
        { error: 'Invalid key format' },
        { status: 400 }
      );
    }

    const finalFavorite = {
      ...favorite,
      save_time: favorite.save_time ?? Date.now(),
    } as Favorite;

    await db.saveFavorite(LOCAL_AUTH_SUBJECT, source, id, finalFavorite);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('保存收藏失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/favorites
 *
 * 1. 不带 query -> 清空全部收藏
 * 2. 带 key=source+id -> 删除单条收藏
 */
export async function DELETE(request: NextRequest) {
  try {
    if (!hasServerStorage()) {
      return NextResponse.json(
        { error: '本地存储模式不提供服务端数据接口' },
        { status: 400 }
      );
    }

    const username = LOCAL_AUTH_SUBJECT;
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (key) {
      // 删除单条
      const [source, id] = key.split('+');
      if (!source || !id) {
        return NextResponse.json(
          { error: 'Invalid key format' },
          { status: 400 }
        );
      }
      await db.deleteFavorite(username, source, id);
    } else {
      // 清空全部
      const all = await db.getAllFavorites(username);
      await Promise.all(
        Object.keys(all).map(async (k) => {
          const [s, i] = k.split('+');
          if (s && i) await db.deleteFavorite(username, s, i);
        })
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('删除收藏失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
