import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { isAdultContent } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const includeAdult = searchParams.get('includeAdult') === 'true';

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      }
    );
  }

  const config = await getConfig();
  let apiSites = config.SourceConfig.filter((site) => !site.disabled);

  // 默认搜索完全移除色情/成人站点
  if (!includeAdult) {
    apiSites = apiSites.filter(
      (site) => site.category !== 'adult' && site.category !== 'erotic'
    );
  }

  const searchPromises = apiSites.map((site) => searchFromApi(site, query));

  try {
    const results = await Promise.all(searchPromises);
    let flattenedResults = results.flat();

    // 默认搜索中严格移除所有色情/成人内容
    if (!includeAdult) {
      flattenedResults = flattenedResults.filter(
        (result) => !isAdultContent(result)
      );
    } else if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter(
        (result) => !isAdultContent(result)
      );
    }

    const cacheTime = await getCacheTime();

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
