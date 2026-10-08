import { NextResponse } from 'next/server';

import { getSearchApiSites } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { jsonCacheHeaders } from '@/lib/edge-cache';
import { viewerLine } from '@/lib/line';
import { isAdultContent, isAdultSource } from '@/lib/yellow';

export const runtime = 'edge';

function searchCacheHeaders() {
  // 浏览器 60 秒，边缘 300 秒。CDN-Cache-Control 只给 Cloudflare 边缘看。
  return jsonCacheHeaders(300, 60);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json(
      { results: [] },
      { headers: searchCacheHeaders() }
    );
  }

  const line = viewerLine(request);
  const apiSites = (await getSearchApiSites(line)).filter(
    (site) => !isAdultSource(site)
  );

  try {
    const results = await Promise.all(
      apiSites.map((site) => searchFromApi(site, query))
    );
    const flattenedResults = results.flatMap((list, index) =>
      list
        .filter((item) => !isAdultContent(item))
        .map((item) => ({
          ...item,
          source_rank: index + 1,
        }))
    );

    return NextResponse.json(
      { results: flattenedResults, line },
      { headers: searchCacheHeaders() }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
