import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { DoubanItem } from '@/lib/types';

export const runtime = 'edge';

const EDGE_SECONDS = 1800;
const BROWSER_SECONDS = 300;
const PAGE_SIZE = 20;

const BILIBILI_KIND: Record<string, number> = {
  bangumi: 1,
  movie: 2,
  documentary: 3,
  guochuang: 4,
  tv: 5,
  variety: 7,
};

function asPage(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function rateText(value: unknown): string {
  const text = String(value ?? '')
    .replace('分', '')
    .trim();
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '';
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

interface BangumiSubject {
  id?: number | string;
  name?: string;
  name_cn?: string;
  date?: string;
  images?: { large?: string; common?: string };
  rating?: { score?: number };
}

interface BilibiliRankItem {
  season_id?: number | string;
  title?: string;
  cover?: string;
  ss_horizontal_cover?: string;
  rating?: string | number;
}

async function loadBangumi(kind: string, page: number) {
  const type = kind === 'real' ? 6 : 2;
  const offset = (page - 1) * PAGE_SIZE;
  const data = (await fetchJson(
    `https://api.bgm.tv/v0/subjects?type=${type}&sort=rank&limit=${PAGE_SIZE}&offset=${offset}`,
    {
      Accept: 'application/json',
      'User-Agent': 'cktv/1.0 (tv.chuankangkk.top)',
    }
  )) as { data?: BangumiSubject[]; total?: number };
  const list: DoubanItem[] = (Array.isArray(data?.data) ? data.data : []).map(
    (item) => ({
      id: String(item.id || ''),
      title: item.name_cn || item.name || '',
      poster: item.images?.large || item.images?.common || '',
      rate: rateText(item.rating?.score),
      year: String(item.date || '').slice(0, 4),
    })
  );
  const total = Number(data?.total) || list.length;
  return {
    list: list.filter((item) => item.id && item.title),
    page,
    pagecount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

async function loadBilibili(kind: string, page: number) {
  const seasonType = BILIBILI_KIND[kind] || BILIBILI_KIND.bangumi;
  const data = (await fetchJson(
    `https://api.bilibili.com/pgc/season/rank/web/list?season_type=${seasonType}&day=3`,
    {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json',
    }
  )) as { data?: { list?: BilibiliRankItem[] } };
  const all = (data?.data?.list || []).map((item) => ({
    id: String(item.season_id || ''),
    title: item.title || '',
    poster: item.cover || item.ss_horizontal_cover || '',
    rate: rateText(item.rating),
    year: '',
  }));
  const start = (page - 1) * PAGE_SIZE;
  return {
    list: all
      .slice(start, start + PAGE_SIZE)
      .filter((item) => item.id && item.title),
    page,
    pagecount: Math.max(1, Math.ceil(all.length / PAGE_SIZE)),
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
  const engine =
    searchParams.get('engine') === 'bilibili' ? 'bilibili' : 'bangumi';
  const kind =
    searchParams.get('kind') || (engine === 'bilibili' ? 'bangumi' : 'anime');
  const page = asPage(searchParams.get('page'));
  const cacheUrl = `https://cktv-cache.local/catalog?engine=${engine}&kind=${encodeURIComponent(
    kind
  )}&page=${page}&v=1`;
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    return new NextResponse(await hit.text(), {
      headers: {
        ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
        'x-ck-cache': 'HIT',
      },
    });
  }

  try {
    const payload =
      engine === 'bilibili'
        ? await loadBilibili(kind, page)
        : await loadBangumi(kind, page);
    const body = JSON.stringify(payload);
    if (payload.list.length > 0) {
      writeJsonCache(ctx, cacheUrl, body, EDGE_SECONDS, BROWSER_SECONDS);
    }
    return new NextResponse(body, {
      headers: {
        ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'MISS',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { list: [], page, pagecount: 1, error: (error as Error).message },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
