import { NextResponse } from 'next/server';

import { getSearchApiSites } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { jsonCacheHeaders } from '@/lib/edge-cache';
import { viewerLine } from '@/lib/line';
import { isAdultContent, isAdultSource } from '@/lib/yellow';

export const runtime = 'edge';

// OrionTV 兼容接口。成人源不在这里查询。
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const resourceId = searchParams.get('resourceId');

  const headers = jsonCacheHeaders(300, 60);

  if (!query || !resourceId) {
    return NextResponse.json(
      { result: null, error: '缺少必要参数: q 或 resourceId' },
      { headers }
    );
  }

  const apiSites = await getSearchApiSites(viewerLine(request));

  try {
    const targetSite = apiSites.find((site) => site.key === resourceId);
    if (!targetSite || isAdultSource(targetSite)) {
      return NextResponse.json(
        {
          error: `未找到指定的视频源: ${resourceId}`,
          result: null,
        },
        { status: 404 }
      );
    }

    const results = await searchFromApi(targetSite, query);
    const result = results.filter(
      (item) => item.title === query && !isAdultContent(item)
    );

    if (result.length === 0) {
      return NextResponse.json(
        {
          error: '未找到结果',
          result: null,
        },
        { status: 404, headers }
      );
    }

    return NextResponse.json({ results: result }, { headers });
  } catch (error) {
    return NextResponse.json(
      {
        error: '搜索失败',
        result: null,
      },
      { status: 500 }
    );
  }
}
