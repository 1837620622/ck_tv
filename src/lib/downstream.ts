import { API_CONFIG, ApiSite } from '@/lib/config';
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

// 最近失败过的源（超时、网络错误、非 200、返回的不是 JSON）。
// 同一个实例里暂时不占快速查询名额，5 分钟后自动恢复。
const FAILURE_MEMO_MS = 5 * 60 * 1000;
const failedSites = new Map<string, number>();

export function recentlyFailed(siteKey: string): boolean {
  const at = failedSites.get(siteKey);
  if (at === undefined) return false;
  if (Date.now() - at > FAILURE_MEMO_MS) {
    failedSites.delete(siteKey);
    return false;
  }
  return true;
}

function noteSite(siteKey: string, ok: boolean) {
  if (ok) failedSites.delete(siteKey);
  else failedSites.set(siteKey, Date.now());
}

// 把苹果 CMS 的一条记录转成站内结构。上游字段类型不稳定（数字、空值），先统一转字符串；
// 单条坏数据只丢掉这一条，不会让整个源的结果一起丢失。
function toSearchResult(
  item: ApiSearchItem,
  apiSite: ApiSite
): SearchResult | null {
  try {
    if (
      item.vod_id === undefined ||
      item.vod_id === null ||
      item.vod_id === ''
    ) {
      return null;
    }
    const yearText =
      item.vod_year === undefined || item.vod_year === null
        ? ''
        : String(item.vod_year);
    return {
      id: String(item.vod_id),
      title: repairTitle(String(item.vod_name ?? '')),
      poster: String(item.vod_pic ?? ''),
      episodes: item.vod_play_url
        ? extractPlayUrls(String(item.vod_play_url))
        : [],
      source: apiSite.key,
      source_name: apiSite.name,
      class: item.vod_class,
      year: yearText ? yearText.match(/\d{4}/)?.[0] || '' : 'unknown',
      desc: cleanHtmlTags(String(item.vod_content ?? '')),
      type_name: item.type_name,
      douban_id: item.vod_douban_id,
    };
  } catch {
    return null;
  }
}

interface ApiListPayload {
  list?: ApiSearchItem[];
  pagecount?: number;
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  options?: { keepAdult?: boolean; timeoutMs?: number; page?: number }
): Promise<SearchResult[]> {
  const pageNo = Math.max(1, Math.floor(options?.page || 1));
  const pageSuffix = pageNo > 1 ? `&pg=${pageNo}` : '';
  const apiUrl =
    apiSite.api +
    API_CONFIG.search.path +
    encodeURIComponent(query) +
    pageSuffix;
  // 国内首批查询用更短的超时，避免慢源占住连接。超时同样覆盖读取 body 的时间。
  const budgetMs = options?.timeoutMs ?? 2800;

  const attempt = async (): Promise<{
    data: ApiListPayload | null;
    retryable: boolean;
  }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const response = await fetch(
        apiUrl,
        edgeFetchInit(API_CONFIG.search.headers, controller.signal, 1800)
      );
      if (!response.ok) {
        return {
          data: null,
          retryable: response.status >= 500 || response.status === 429,
        };
      }
      return { data: await response.json(), retryable: false };
    } catch {
      // 连接被重置、返回的不是 JSON 多半是瞬时的；超时不再重试
      return { data: null, retryable: !controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let outcome = await attempt();
    if (!outcome.data && outcome.retryable) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      outcome = await attempt();
    }
    const data = outcome.data;
    if (!data) {
      noteSite(apiSite.key, false);
      return [];
    }
    noteSite(apiSite.key, true);
    if (!Array.isArray(data.list) || data.list.length === 0) {
      return [];
    }

    // 每个源只取第一页。多页会打满 Cloudflare 子请求，也会把模糊命中的成人条目翻出来。
    const results = (data.list as ApiSearchItem[])
      .map((item) => toSearchResult(item, apiSite))
      .filter((item): item is SearchResult => item !== null);
    const tagged = results as SearchResult[] & { pageCount?: number };
    tagged.pageCount = Number(data.pagecount) || 1;
    if (options?.keepAdult) {
      return tagged;
    }
    return tagged.filter((item: SearchResult) => !isAdultContent(item));
  } catch {
    noteSite(apiSite.key, false);
    return [];
  }
}

// 保留 .m3u8 后面的签名参数。问号、括号都可能是地址的一部分，不能在那里截断。
const M3U8_PATTERN =
  /(https?:\/\/[^\s"'<>，。！？、；：）】》]+?\.m3u8[^\s"'<>，。！？、；：）】》]*)/g;

function episodeUrl(episode: string): string {
  // 地址从第一个 http(s):// 开始，到空白或 $ 为止；集名里的 $ 或 "名$$地址" 写法都能正确取出
  const match = episode.match(/https?:\/\/[^\s$]+/);
  if (!match) return '';
  return match[0].replace(/（[^）]*）\s*$/u, '');
}

// 苹果 CMS 播放串：线路用 $$$，集数用 #，集名和地址用 $。
// 多条线路时优先选 m3u8 数量多的（网页端能稳定播放的是 hls），数量相同再比集数，同分保留靠前的线路。
export function extractPlayUrls(vodPlayUrl: string): string[] {
  const groups = String(vodPlayUrl).split('$$$');
  let best: string[] = [];
  let bestM3u8 = -1;
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
    const chosenM3u8 = chosen.filter((url) => url.includes('.m3u8')).length;
    if (
      chosenM3u8 > bestM3u8 ||
      (chosenM3u8 === bestM3u8 && chosen.length > best.length)
    ) {
      best = chosen;
      bestM3u8 = chosenM3u8;
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

  const detailUrl = `${apiSite.api}${
    API_CONFIG.detail.path
  }${encodeURIComponent(id)}`;
  let data: ApiListPayload | null = null;
  let lastError: unknown = null;
  for (const timeoutMs of [6000, 4000]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        detailUrl,
        edgeFetchInit(API_CONFIG.detail.headers, controller.signal, 600)
      );
      if (!response.ok) {
        lastError = new Error(`详情请求失败: ${response.status}`);
        if (response.status < 500) break;
        continue;
      }
      data = await response.json();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (controller.signal.aborted) break;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError) throw lastError;

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
    const matches = String(videoDetail.vod_content).match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  const yearText =
    videoDetail.vod_year === undefined || videoDetail.vod_year === null
      ? ''
      : String(videoDetail.vod_year);
  return {
    id: id.toString(),
    title: repairTitle(String(videoDetail.vod_name ?? '')),
    poster: String(videoDetail.vod_pic ?? ''),
    episodes,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: yearText ? yearText.match(/\d{4}/)?.[0] || '' : 'unknown',
    desc: cleanHtmlTags(String(videoDetail.vod_content ?? '')),
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
