import { DoubanItem, DoubanResult } from './types';
import { getDoubanProxyUrl } from './utils';

interface DoubanCategoriesParams {
  kind: 'tv' | 'movie';
  category: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
}

interface DoubanCategoryApiResponse {
  items?: unknown;
  subjects?: unknown;
}

interface DoubanRequestOptions {
  silent?: boolean;
}

interface RawDoubanRow {
  id?: string | number;
  title?: string;
  card_subtitle?: string;
  cover?: string;
  rate?: string;
  pic?: { large?: string; normal?: string };
  rating?: { value?: number };
}

const DOUBAN_REGION_TYPES = new Set([
  '全部',
  '华语',
  '欧美',
  '韩国',
  '日本',
  'tv',
  'tv_domestic',
  'tv_american',
  'tv_japanese',
  'tv_korean',
  'tv_animation',
  'tv_documentary',
  'show',
  'show_domestic',
  'show_foreign',
]);

function notifyDoubanError(message: string, silent?: boolean) {
  if (silent || typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('globalError', {
      detail: { message },
    })
  );
}

function mapDoubanRows(rows: unknown): DoubanItem[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const item = (row || {}) as RawDoubanRow;
      const score = Number(item.rating?.value);
      return {
        id: String(item.id ?? ''),
        title: item.title || '',
        poster: item.cover || item.pic?.normal || item.pic?.large || '',
        rate:
          item.rate ||
          (Number.isFinite(score) && score > 0 ? score.toFixed(1) : ''),
        year: String(item.card_subtitle || '').match(/(\d{4})/)?.[1] || '',
      };
    })
    .filter((item) => item.id && item.title);
}

/**
 * 带超时的 fetch 请求
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

  // 检查是否使用代理
  const proxyUrl = getDoubanProxyUrl();
  const finalUrl = proxyUrl ? `${proxyUrl}${encodeURIComponent(url)}` : url;

  const fetchOptions: RequestInit = {
    ...options,
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      ...options.headers,
    },
  };

  try {
    const response = await fetch(finalUrl, fetchOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * 检查是否应该使用客户端获取豆瓣数据
 */
export function shouldUseDoubanClient(): boolean {
  return getDoubanProxyUrl() !== null;
}

/**
 * 浏览器端豆瓣分类数据获取函数
 */
export async function fetchDoubanCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;

  // 验证参数
  if (!['tv', 'movie'].includes(kind)) {
    throw new Error('kind 参数必须是 tv 或 movie');
  }

  if (!category || !type) {
    throw new Error('category 和 type 参数不能为空');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  // recent_hot 对喜剧、动作这类题材会返回空列表，题材改走 search_subjects。
  const movieGenre = kind === 'movie' && !DOUBAN_REGION_TYPES.has(type);
  const subjectSort =
    category === '最新'
      ? 'time'
      : category === '豆瓣高分'
      ? 'rank'
      : 'recommend';
  const subjectTag = movieGenre ? type : category || type || '热门';
  const recentHotUrl = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${encodeURIComponent(
    category
  )}&type=${encodeURIComponent(type)}`;
  const subjectUrl = `https://movie.douban.com/j/search_subjects?type=${
    kind === 'tv' ? 'tv' : 'movie'
  }&tag=${encodeURIComponent(
    subjectTag
  )}&sort=${subjectSort}&page_limit=${pageLimit}&page_start=${pageStart}`;

  let list: DoubanItem[] = [];
  if (!movieGenre) {
    try {
      const response = await fetchWithTimeout(recentHotUrl);
      if (response.ok) {
        const doubanData = (await response.json()) as DoubanCategoryApiResponse;
        list = mapDoubanRows(doubanData.items);
      }
    } catch {
      list = [];
    }
  }

  if (list.length === 0) {
    const response = await fetchWithTimeout(subjectUrl);
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    const doubanData = (await response.json()) as DoubanCategoryApiResponse;
    list = mapDoubanRows(doubanData.subjects);
  }

  return {
    code: 200,
    message: '获取成功',
    list,
  };
}

async function fetchServerCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;
  const response = await fetch(
    `/api/douban/categories?kind=${kind}&category=${encodeURIComponent(
      category
    )}&type=${encodeURIComponent(type)}&limit=${pageLimit}&start=${pageStart}`,
    { cache: 'no-store' }
  );

  if (!response.ok) {
    throw new Error('获取豆瓣分类数据失败');
  }

  const data = (await response.json()) as Partial<DoubanResult>;
  return {
    code: 200,
    message: data.message || '获取成功',
    list: Array.isArray(data.list) ? data.list : [],
  };
}

/**
 * 统一的豆瓣分类数据获取函数，根据代理设置选择使用服务端 API 或客户端代理获取。
 * 失败重试一次。首页传 silent，避免一行失败就弹六次。
 */
export async function getDoubanCategories(
  params: DoubanCategoriesParams,
  options?: DoubanRequestOptions
): Promise<DoubanResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (shouldUseDoubanClient()) {
        return await fetchDoubanCategories(params);
      }
      return await fetchServerCategories(params);
    } catch (error) {
      lastError = error;
    }
  }

  notifyDoubanError('获取豆瓣分类数据失败', options?.silent);
  throw lastError instanceof Error
    ? lastError
    : new Error('获取豆瓣分类数据失败');
}

interface DoubanListParams {
  tag: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
}

export async function getDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;
  if (shouldUseDoubanClient()) {
    // 使用客户端代理获取（当设置了代理 URL 时）
    return fetchDoubanList(params);
  } else {
    // 对中文参数进行URL编码，避免请求失败
    const response = await fetch(
      `/api/douban?tag=${encodeURIComponent(tag)}&type=${encodeURIComponent(
        type
      )}&pageSize=${pageLimit}&pageStart=${pageStart}`
    );

    if (!response.ok) {
      // 触发全局错误提示
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('globalError', {
            detail: { message: '获取豆瓣列表数据失败' },
          })
        );
      }
      throw new Error('获取豆瓣列表数据失败');
    }

    return response.json();
  }
}

export async function fetchDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;

  // 验证参数
  if (!tag || !type) {
    throw new Error('tag 和 type 参数不能为空');
  }

  if (!['tv', 'movie'].includes(type)) {
    throw new Error('type 参数必须是 tv 或 movie');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${tag}&sort=recommend&page_limit=${pageLimit}&page_start=${pageStart}`;

  try {
    const response = await fetchWithTimeout(target);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const doubanData = (await response.json()) as DoubanCategoryApiResponse;
    const list = mapDoubanRows(doubanData.subjects ?? doubanData.items);

    return {
      code: 200,
      message: '获取成功',
      list: list,
    };
  } catch (error) {
    // 触发全局错误提示
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('globalError', {
          detail: { message: '获取豆瓣列表数据失败' },
        })
      );
    }
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}
