/* eslint-disable @typescript-eslint/no-explicit-any */
import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getAdultApiSites, getConfig } from '@/lib/config';
import { extractPlayUrls, searchFromApi } from '@/lib/downstream';
import {
  edgeFetchInit,
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { settleWithin } from '@/lib/settle';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';
import { adultSourceKeys, isUnderageLabel } from '@/lib/yellow';

function asPage(value: unknown, fallback = 1): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function allowedCategory(item: { type_name?: string }) {
  return !isUnderageLabel(item?.type_name);
}

function cleanPoster(raw: unknown): string {
  const text = String(raw || '')
    .replace(/[\r\n\t]/g, '')
    .trim();
  if (!text) return '';
  const first = text.split('#')[0].trim();
  if (first.startsWith('//')) return `https:${first}`;
  return first;
}

export const runtime = 'edge';

const ADULT_EDGE_SECONDS = 1800;
const ADULT_BROWSER_SECONDS = 60;

function adultCacheHeaders(state: string) {
  return {
    ...jsonCacheHeaders(ADULT_EDGE_SECONDS, ADULT_BROWSER_SECONDS),
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
  const action = searchParams.get('action') || 'list';
  const query = searchParams.get('q');
  const source = searchParams.get('source') || 'zy91md';
  const page = asPage(searchParams.get('page'), 1);
  const typeId = searchParams.get('t') || '';

  let adultSites = await getAdultApiSites();
  if (!adultSites || adultSites.length === 0) {
    const config = await getConfig();
    adultSites = config.SourceConfig.filter(
      (site) =>
        !site.disabled &&
        (site.category === 'adult' ||
          site.category === 'erotic' ||
          adultSourceKeys.includes(site.key))
    );
  }

  if (adultSites.length === 0) {
    return NextResponse.json({
      code: 1,
      list: [],
      sources: [],
      categories: [],
      page: 1,
      pagecount: 1,
    });
  }

  // 1. 独立搜索动作
  if (action === 'search' || (query && query.trim())) {
    const q = (query || '').trim();
    if (!q) {
      return NextResponse.json({ list: [] });
    }
    const cacheUrl = `https://cktv-cache.local/adult-search?q=${encodeURIComponent(
      q
    )}&page=${page}&v=6`;
    try {
      const hit = await readJsonCache(cacheUrl);
      if (hit) {
        return new NextResponse(await hit.text(), {
          headers: adultCacheHeaders('HIT'),
        });
      }
      const settled = await settleWithin(
        adultSites.map((site) =>
          searchFromApi(site, q, {
            keepAdult: true,
            timeoutMs: 2200,
            page,
          })
        ),
        1400,
        [] as SearchResult[]
      );
      const flattened = settled.values
        .flat()
        .filter(
          (item) =>
            !isUnderageLabel(item.title) &&
            !isUnderageLabel(item.type_name) &&
            !isUnderageLabel(item.class)
        )
        .map((item) => ({ ...item, poster: cleanPoster(item.poster) }));
      const pagecount = Math.max(
        1,
        ...settled.values.map(
          (list) => Number((list as { pageCount?: number }).pageCount) || 1
        )
      );
      const body = JSON.stringify({
        list: flattened,
        total: flattened.length,
        page,
        pagecount,
      });
      const store = () => {
        const full = settled.values
          .flat()
          .filter(
            (item) =>
              !isUnderageLabel(item.title) &&
              !isUnderageLabel(item.type_name) &&
              !isUnderageLabel(item.class)
          )
          .map((item) => ({ ...item, poster: cleanPoster(item.poster) }));
        if (full.length === 0) return;
        const fullCount = Math.max(
          1,
          ...settled.values.map(
            (list) => Number((list as { pageCount?: number }).pageCount) || 1
          )
        );
        writeJsonCache(
          ctx,
          cacheUrl,
          JSON.stringify({
            list: full,
            total: full.length,
            page,
            pagecount: fullCount,
          }),
          ADULT_EDGE_SECONDS,
          ADULT_BROWSER_SECONDS
        );
      };
      if (settled.complete) {
        if (flattened.length > 0) store();
      } else {
        ctx?.waitUntil(settled.done.then(store).catch(() => undefined));
      }
      return new NextResponse(body, {
        headers: adultCacheHeaders(settled.complete ? 'MISS' : 'PARTIAL'),
      });
    } catch {
      return NextResponse.json({ list: [] });
    }
  }

  // 2. 获取分类动作
  const currentSite = adultSites.find((s) => s.key === source) || adultSites[0];
  if (action === 'types') {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(
        `${currentSite.api}?ac=list`,
        edgeFetchInit(
          {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/json',
          },
          controller.signal,
          180
        )
      );
      clearTimeout(timeoutId);
      if (!res.ok) return NextResponse.json({ categories: [] });
      const data = await res.json();
      return NextResponse.json({
        categories: (data?.class || []).filter(allowedCategory),
      });
    } catch {
      return NextResponse.json({ categories: [] });
    }
  }

  // 3. 列表分页动作
  const listCacheUrl = `https://cktv-cache.local/adult-list?source=${encodeURIComponent(
    currentSite.key
  )}&page=${page}&t=${encodeURIComponent(typeId)}&v=6`;
  const listHit = await readJsonCache(listCacheUrl);
  if (listHit) {
    return new NextResponse(await listHit.text(), {
      headers: adultCacheHeaders('HIT'),
    });
  }

  try {
    const tParam = typeId ? `&t=${encodeURIComponent(typeId)}` : '';
    const apiUrl = `${currentSite.api}?ac=videolist&pg=${page}${tParam}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(
      apiUrl,
      edgeFetchInit(
        {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json',
        },
        controller.signal,
        180
      )
    );
    clearTimeout(timeoutId);
    if (!res.ok) {
      return NextResponse.json({
        list: [],
        page,
        pagecount: 1,
        categories: [],
        sources: adultSites.map((s) => ({ key: s.key, name: s.name })),
      });
    }

    const data = await res.json();
    const rawList = data?.list || [];
    const categories = (data?.class || []).filter(allowedCategory);

    const formattedList = rawList
      .map((item: any) => {
        return {
          id: item.vod_id?.toString() || '',
          title: (item.vod_name || '').trim(),
          poster: cleanPoster(item.vod_pic),
          episodes: item.vod_play_url ? extractPlayUrls(item.vod_play_url) : [],
          source: currentSite.key,
          source_name: currentSite.name,
          class: item.vod_class || '',
          year: item.vod_year?.toString() || 'unknown',
          desc: cleanHtmlTags(item.vod_content || ''),
          type_name: item.type_name || '',
          douban_id: 0,
        };
      })
      .filter(
        (item: SearchResult) =>
          !isUnderageLabel(item.title) &&
          !isUnderageLabel(item.type_name) &&
          !isUnderageLabel(item.class)
      );

    const payload = {
      list: formattedList,
      page: asPage(data.page, page),
      pagecount: asPage(data.pagecount, 1),
      total: data.total || 0,
      categories,
      sources: adultSites.map((s) => ({ key: s.key, name: s.name })),
    };
    const body = JSON.stringify(payload);
    if (formattedList.length > 0) {
      writeJsonCache(
        ctx,
        listCacheUrl,
        body,
        ADULT_EDGE_SECONDS,
        ADULT_BROWSER_SECONDS
      );
    }
    return new NextResponse(body, {
      headers: {
        ...adultCacheHeaders('MISS'),
        'content-type': 'application/json; charset=utf-8',
      },
    });
  } catch (error) {
    return NextResponse.json({
      list: [],
      page,
      pagecount: 1,
      sources: adultSites.map((s) => ({ key: s.key, name: s.name })),
      categories: [],
    });
  }
}
