import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { edgeFetchInit } from '@/lib/edge-cache';
import { repairTitle } from '@/lib/match-title';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';
import { isAdultContent } from '@/lib/yellow';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  options?: { keepAdult?: boolean; timeoutMs?: number; page?: number }
): Promise<SearchResult[]> {
  try {
    const apiBaseUrl = apiSite.api;
    const pageNo = Math.max(1, Math.floor(options?.page || 1));
    const pageSuffix = pageNo > 1 ? `&pg=${pageNo}` : '';
    const apiUrl =
      apiBaseUrl +
      API_CONFIG.search.path +
      encodeURIComponent(query) +
      pageSuffix;
    const apiName = apiSite.name;

    // 国内首批查询用更短的超时，避免慢源占住连接。
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? 2800
    );

    const response = await fetch(
      apiUrl,
      edgeFetchInit(API_CONFIG.search.headers, controller.signal, 1800)
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    if (
      !data ||
      !data.list ||
      !Array.isArray(data.list) ||
      data.list.length === 0
    ) {
      return [];
    }
    // 处理第一页结果
    const results: SearchResult[] = data.list.map((item: ApiSearchItem) => {
      const episodes = item.vod_play_url
        ? extractPlayUrls(item.vod_play_url)
        : [];

      return {
        id: item.vod_id.toString(),
        title: repairTitle(item.vod_name),
        poster: item.vod_pic,
        episodes,
        source: apiSite.key,
        source_name: apiName,
        class: item.vod_class,
        year: item.vod_year
          ? item.vod_year.match(/\d{4}/)?.[0] || ''
          : 'unknown',
        desc: cleanHtmlTags(item.vod_content || ''),
        type_name: item.type_name,
        douban_id: item.vod_douban_id,
      };
    });

    const config = await getConfig();
    // 每个源只取第一页。多页会打满 Cloudflare 子请求，也会把模糊命中的成人条目翻出来。
    const configuredPages =
      Number(config.SiteConfig.SearchDownstreamMaxPage) || 1;
    const MAX_SEARCH_PAGES = Math.min(Math.max(configuredPages, 1), 1);

    const pageCount = data.pagecount || 1;
    const pagesToFetch = Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);

    // 如果有额外页数，获取更多页的结果
    if (pagesToFetch > 0) {
      const additionalPagePromises = [];

      for (let page = 2; page <= pagesToFetch + 1; page++) {
        const pageUrl =
          apiBaseUrl +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());

        const pagePromise = (async () => {
          try {
            const pageController = new AbortController();
            const pageTimeoutId = setTimeout(
              () => pageController.abort(),
              2800
            );

            const pageResponse = await fetch(
              pageUrl,
              edgeFetchInit(
                API_CONFIG.search.headers,
                pageController.signal,
                300
              )
            );

            clearTimeout(pageTimeoutId);

            if (!pageResponse.ok) return [];

            const pageData = await pageResponse.json();

            if (!pageData || !pageData.list || !Array.isArray(pageData.list))
              return [];

            return pageData.list.map((item: ApiSearchItem) => {
              const episodes = item.vod_play_url
                ? extractPlayUrls(item.vod_play_url)
                : [];

              return {
                id: item.vod_id.toString(),
                title: repairTitle(item.vod_name),
                poster: item.vod_pic,
                episodes,
                source: apiSite.key,
                source_name: apiName,
                class: item.vod_class,
                year: item.vod_year
                  ? item.vod_year.match(/\d{4}/)?.[0] || ''
                  : 'unknown',
                desc: cleanHtmlTags(item.vod_content || ''),
                type_name: item.type_name,
                douban_id: item.vod_douban_id,
              };
            });
          } catch (error) {
            return [];
          }
        })();

        additionalPagePromises.push(pagePromise);
      }

      // 等待所有额外页的结果
      const additionalResults = await Promise.all(additionalPagePromises);

      // 合并所有页的结果
      additionalResults.forEach((pageResults) => {
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }
      });
    }

    const tagged = results as SearchResult[] & { pageCount?: number };
    tagged.pageCount = Number(data.pagecount) || 1;
    if (options?.keepAdult) {
      return tagged;
    }
    return tagged.filter((item: SearchResult) => !isAdultContent(item));
  } catch (error) {
    return [];
  }
}

// 保留 .m3u8 后面的签名参数。问号、括号都可能是地址的一部分，不能在那里截断。
const M3U8_PATTERN =
  /(https?:\/\/[^\s"'<>，。！？、；：）】》]+?\.m3u8[^\s"'<>，。！？、；：）】》]*)/g;

function episodeUrl(episode: string): string {
  const dollar = episode.indexOf('$');
  const raw = (dollar < 0 ? episode : episode.slice(dollar + 1)).trim();
  return raw.replace(/（[^）]*）\s*$/u, '');
}

// 苹果 CMS 播放串：线路用 $$$，集数用 #，集名和地址用 $。
export function extractPlayUrls(vodPlayUrl: string): string[] {
  const groups = String(vodPlayUrl).split('$$$');
  let best: string[] = [];
  for (const group of groups) {
    const urls = group
      .split('#')
      .map(episodeUrl)
      .filter((url) => url.startsWith('http://') || url.startsWith('https://'));
    const m3u8s = urls.filter((url) => url.includes('.m3u8'));
    const others = urls.filter((url) => !url.includes('.m3u8'));
    // 整组以 m3u8 为主才只用 m3u8。只有一条预告 m3u8、正片是 mp4 时不能把正片丢掉。
    const chosen =
      m3u8s.length === 0
        ? urls
        : m3u8s.length >= others.length
        ? m3u8s
        : others;
    if (chosen.length > best.length) {
      best = chosen;
    }
  }
  return Array.from(new Set(best));
}

export async function getDetailFromApi(
  apiSite: ApiSite,
  id: string
): Promise<SearchResult> {
  if (apiSite.detail) {
    return handleSpecialSourceDetail(id, apiSite);
  }

  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(
    detailUrl,
    edgeFetchInit(API_CONFIG.detail.headers, controller.signal, 600)
  );

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情请求失败: ${response.status}`);
  }

  const data = await response.json();

  if (
    !data ||
    !data.list ||
    !Array.isArray(data.list) ||
    data.list.length === 0
  ) {
    throw new Error('获取到的详情内容无效');
  }

  const videoDetail = data.list[0];
  let episodes: string[] = videoDetail.vod_play_url
    ? extractPlayUrls(String(videoDetail.vod_play_url))
    : [];

  // 如果播放源为空，则尝试从内容中解析 m3u8
  if (episodes.length === 0 && videoDetail.vod_content) {
    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  return {
    id: id.toString(),
    title: repairTitle(videoDetail.vod_name),
    poster: videoDetail.vod_pic,
    episodes,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: videoDetail.vod_year
      ? videoDetail.vod_year.match(/\d{4}/)?.[0] || ''
      : 'unknown',
    desc: cleanHtmlTags(videoDetail.vod_content),
    type_name: videoDetail.type_name,
    douban_id: videoDetail.vod_douban_id,
  };
}

async function handleSpecialSourceDetail(
  id: string,
  apiSite: ApiSite
): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const response = await fetch(
    detailUrl,
    edgeFetchInit(API_CONFIG.detail.headers, controller.signal, 600)
  );

  clearTimeout(timeoutId);

  if (!response.ok) {
    throw new Error(`详情页请求失败: ${response.status}`);
  }

  const html = await response.text();
  let matches: string[] = [];

  if (apiSite.key === 'ffzy') {
    const ffzyPattern =
      /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8[^\s"'<>]*)/g;
    matches = html.match(ffzyPattern) || [];
  }

  if (matches.length === 0) {
    const generalPattern =
      /\$(https?:\/\/[^\s"'<>，。！？、；：）】》]+?\.m3u8[^\s"'<>，。！？、；：）】》]*)/g;
    matches = html.match(generalPattern) || [];
  }

  // 去掉开头的 $，签名参数和路径里的括号都保留。
  matches = Array.from(new Set(matches)).map((link: string) =>
    link.startsWith('$') ? link.slice(1) : link
  );

  // 提取标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const titleText = titleMatch ? repairTitle(titleMatch[1]) : '';

  // 提取描述
  const descMatch = html.match(
    /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/
  );
  const descText = descMatch ? cleanHtmlTags(descMatch[1]) : '';

  // 提取封面
  const coverMatch = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/g);
  const coverUrl = coverMatch ? coverMatch[0].trim() : '';

  // 提取年份
  const yearMatch = html.match(/>(\d{4})</);
  const yearText = yearMatch ? yearMatch[1] : 'unknown';

  return {
    id,
    title: titleText,
    poster: coverUrl,
    episodes: matches,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year: yearText,
    desc: descText,
    type_name: '',
    douban_id: 0,
  };
}
