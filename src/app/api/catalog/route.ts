import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { DoubanItem } from '@/lib/types';

export const runtime = 'edge';

const EDGE_SECONDS = 7200;
const BROWSER_SECONDS = 300;
const PAGE_SIZE = 20;

// 翻页信息。totalKnown 为 false 时 pagecount 只是下界，不是真实总页数，前端不能拿来当分母
interface CatalogPage {
  list: DoubanItem[];
  page: number;
  pagecount: number;
  hasMore: boolean;
  totalKnown: boolean;
}

function knownTotal(
  list: DoubanItem[],
  page: number,
  total: number
): CatalogPage {
  const pagecount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return { list, page, pagecount, hasMore: page < pagecount, totalKnown: true };
}

// 上游不给总数时只能看本页是否满员，满了就认为后面还有一页。
// 满员要看上游原始条数：过滤掉的坏条目不能让第 1 页少了翻页。
function unknownTotal(
  list: DoubanItem[],
  page: number,
  upstreamCount = list.length
): CatalogPage {
  const hasMore = upstreamCount >= PAGE_SIZE;
  return {
    list,
    page,
    pagecount: page + (hasMore ? 1 : 0),
    hasMore,
    totalKnown: false,
  };
}

// 空页或出错：不知道总页数，只把当前页号告诉前端，不能伪造成「共 1 页」
function emptyPage(page: number): CatalogPage {
  return { list: [], page, pagecount: page, hasMore: false, totalKnown: false };
}

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

// 上游只认有限几个 kind，其余值都落到同一条默认路径。
// 缓存键必须用归一后的值：否则每个随机 kind 都是一次缓存未命中，并各自回源一次。
// 用 hasOwnProperty 判断，免得 constructor 之类的属性名也被当成合法 kind。
function canonicalKind(engine: 'bilibili' | 'bangumi', raw: string | null) {
  if (engine === 'bilibili') {
    return raw && Object.prototype.hasOwnProperty.call(BILIBILI_KIND, raw)
      ? raw
      : 'bangumi';
  }
  return raw === 'real' ? 'real' : 'anime';
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

async function loadBangumi(kind: string, page: number): Promise<CatalogPage> {
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
  const rows = list.filter((item) => item.id && item.title);
  const reported = Number(data?.total) || 0;
  return reported > 0
    ? knownTotal(rows, page, reported)
    : unknownTotal(rows, page, list.length);
}

const DOUBAN_KIND: Record<string, { type: string; tag: string }> = {
  bangumi: { type: 'tv', tag: '日本动画' },
  guochuang: { type: 'tv', tag: '国产剧' },
  movie: { type: 'movie', tag: '热门' },
  tv: { type: 'tv', tag: '热门' },
  documentary: { type: 'tv', tag: '纪录片' },
  variety: { type: 'tv', tag: '综艺' },
};

interface DoubanSubject {
  id?: string;
  title?: string;
  cover?: string;
  rate?: string;
}

async function loadDoubanFallback(
  kind: string,
  page: number
): Promise<CatalogPage> {
  const picked = DOUBAN_KIND[kind] || DOUBAN_KIND.bangumi;
  const start = (page - 1) * PAGE_SIZE;
  const data = (await fetchJson(
    `https://movie.douban.com/j/search_subjects?type=${
      picked.type
    }&tag=${encodeURIComponent(picked.tag)}&sort=${
      picked.tag === '日本动画' ? 'rank' : 'recommend'
    }&page_limit=${PAGE_SIZE}&page_start=${start}`,
    {
      Accept: 'application/json',
      Referer: 'https://movie.douban.com/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  )) as { subjects?: DoubanSubject[] };
  const list: DoubanItem[] = (data.subjects || []).map((item) => ({
    id: String(item.id || ''),
    title: item.title || '',
    poster: item.cover || '',
    rate: rateText(item.rate),
    year: '',
  }));
  return unknownTotal(
    list.filter((item) => item.id && item.title),
    page,
    list.length
  );
}

async function loadBilibili(kind: string, page: number): Promise<CatalogPage> {
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
  return knownTotal(
    all.slice(start, start + PAGE_SIZE).filter((item) => item.id && item.title),
    page,
    all.length
  );
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
  const kind = canonicalKind(engine, searchParams.get('kind'));
  const page = asPage(searchParams.get('page'));
  const cacheUrl = `https://cktv-cache.local/catalog?engine=${engine}&kind=${encodeURIComponent(
    kind
  )}&page=${page}&v=4`;
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
    let payload: CatalogPage;
    try {
      payload =
        engine === 'bilibili'
          ? await loadBilibili(kind, page)
          : await loadBangumi(kind, page);
    } catch (error) {
      if (engine !== 'bilibili') throw error;
      // 哔哩榜单从 Cloudflare 出口常返回 412，先记成空列表再走回退
      payload = emptyPage(page);
    }
    if (engine === 'bilibili' && payload.list.length === 0) {
      try {
        payload = await loadDoubanFallback(kind, page);
      } catch {
        payload = emptyPage(page);
      }
    }
    // 豆瓣标签在机房出口也可能是空的；番剧再退到 Bangumi，线上已确认能出片
    if (
      engine === 'bilibili' &&
      payload.list.length === 0 &&
      (kind === 'bangumi' || kind === 'anime')
    ) {
      // 哔哩的榜单页数不能借给 Bangumi 的总数，这里只保留这一页，按满员判断还有没有下一页
      const fallback = await loadBangumi('anime', page);
      payload = unknownTotal(fallback.list, page);
    }
    const body = JSON.stringify(payload);
    if (payload.list.length === 0) {
      return new NextResponse(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
    }
    writeJsonCache(ctx, cacheUrl, body, EDGE_SECONDS, BROWSER_SECONDS);
    return new NextResponse(body, {
      headers: {
        ...jsonCacheHeaders(EDGE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'MISS',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ...emptyPage(page),
        error: (error as Error).message,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
