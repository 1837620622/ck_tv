/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

import { getAdultApiSites, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { edgeFetchInit, jsonCacheHeaders } from '@/lib/edge-cache';
import { cleanHtmlTags } from '@/lib/utils';
import { adultSourceKeys } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') || 'list';
  const query = searchParams.get('q');
  const source = searchParams.get('source') || 'zy91md';
  const page = parseInt(searchParams.get('page') || '1', 10);
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
    const searchPromises = adultSites.map((site) =>
      searchFromApi(site, q, { keepAdult: true })
    );
    try {
      const results = await Promise.all(searchPromises);
      const flattened = results.flat();
      return NextResponse.json(
        {
          list: flattened,
          total: flattened.length,
        },
        { headers: jsonCacheHeaders(180, 30) }
      );
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
        categories: data?.class || [],
      });
    } catch {
      return NextResponse.json({ categories: [] });
    }
  }

  // 3. 列表分页动作
  try {
    const tParam = typeId ? `&t=${encodeURIComponent(typeId)}` : '';
    const apiUrl = `${currentSite.api}?ac=videolist&pg=${page}${tParam}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
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
    const categories = data?.class || [];

    // 格式化为与 SearchResult 兼容的对象
    const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8)/g;
    const formattedList = rawList.map((item: any) => {
      let episodes: string[] = [];
      if (item.vod_play_url) {
        const matches = item.vod_play_url.match(M3U8_PATTERN) || [];
        episodes = Array.from(new Set(matches)).map((link: any) => {
          const parenIndex = link.indexOf('(');
          return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });
      }
      return {
        id: item.vod_id?.toString() || '',
        title: (item.vod_name || '').trim(),
        poster: item.vod_pic || '',
        episodes,
        source: currentSite.key,
        source_name: currentSite.name,
        class: item.vod_class || '',
        year: item.vod_year?.toString() || 'unknown',
        desc: cleanHtmlTags(item.vod_content || ''),
        type_name: item.type_name || '',
        douban_id: 0,
      };
    });

    return NextResponse.json(
      {
        list: formattedList,
        page: data.page || page,
        pagecount: data.pagecount || 1,
        total: data.total || 0,
        categories,
        sources: adultSites.map((s) => ({ key: s.key, name: s.name })),
      },
      { headers: jsonCacheHeaders(180, 30) }
    );
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
