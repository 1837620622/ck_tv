import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import {
  edgeFetchInit,
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { DoubanItem, DoubanResult } from '@/lib/types';

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

async function fetchDoubanData(
  url: string,
  ttlSeconds: number
): Promise<DoubanCategoryApiResponse> {
  // 添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    Referer: 'https://movie.douban.com/',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://movie.douban.com',
  };

  try {
    // 豆瓣原始 JSON 走边缘缓存。首页各分类热门列表命中后不再重复出网。
    const response = await fetch(
      url,
      edgeFetchInit(headers, controller.signal, ttlSeconds)
    );
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export const runtime = 'edge';

function doubanCacheHeaders(
  state: string,
  edgeSeconds: number,
  browserSeconds: number
) {
  return {
    ...jsonCacheHeaders(edgeSeconds, browserSeconds),
    'x-ck-cache': state,
  };
}

export async function GET(request: Request) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!kind || !category || !type) {
    return NextResponse.json(
      { error: '缺少必要参数: kind 或 category 或 type' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;
  const edgeSeconds = await getCacheTime();
  const browserSeconds = Math.min(600, edgeSeconds);
  // Pages Function 响应默认 DYNAMIC，Cache-Control 不会自动进边缘。热门列表单独放进 Cache API。
  const cacheUrl = `https://cktv-cache.local/douban?kind=${encodeURIComponent(
    kind
  )}&category=${encodeURIComponent(category || '')}&type=${encodeURIComponent(
    type || ''
  )}&start=${pageStart}&limit=${pageLimit}&v=1`;

  try {
    const hit = await readJsonCache(cacheUrl);
    if (hit) {
      return new NextResponse(await hit.text(), {
        headers: doubanCacheHeaders('HIT', edgeSeconds, browserSeconds),
      });
    }

    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target, edgeSeconds);

    // 转换数据格式
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    const body = JSON.stringify(response);
    if (list.length > 0) {
      writeJsonCache(ctx, cacheUrl, body, edgeSeconds, browserSeconds);
    }
    return new NextResponse(body, {
      headers: doubanCacheHeaders('MISS', edgeSeconds, browserSeconds),
    });
  } catch (error) {
    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}
