import { isUnderageLabel } from '@/lib/yellow';

const API = 'https://huangguoai.com';
const COVER_HOST = 'pic.wirqed.cn';

function coverPath(url: string): string {
  const clean = url.trim();
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== 'https:' || parsed.hostname !== COVER_HOST)
      return '';
    return `/api/huangguo/cover?u=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return '';
  }
}

const HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  Referer: 'https://huangguoai.com/',
};

export const HUANGGUO_CATEGORIES = [
  { id: 'hot', name: '热门' },
  { id: 'new', name: '最新' },
  { id: 'ai-duanju', name: 'AI短剧' },
  { id: 'ai-manju', name: 'AI漫剧' },
  { id: 'ai-huanlian', name: 'AI换脸' },
  { id: 'ai-mogai', name: 'AI魔改' },
];

interface HuangguoItem {
  id?: number | string;
  title?: string;
  cover?: string;
  episode_count?: number;
  total_episodes?: number;
  tags?: Array<string | { name?: string }>;
  description?: string;
  episodes?: Array<{ ep_num?: number; episode?: number; title?: string }>;
  video_url?: string;
}

export interface HuangguoCard {
  id: string;
  title: string;
  poster: string;
  episodes: string[];
  episode_count?: number;
  source: 'huangguo';
  source_name: string;
  year: string;
  desc?: string;
  type_name?: string;
}

function tagText(item: HuangguoItem): string {
  if (!Array.isArray(item.tags)) return '';
  return item.tags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.name || ''))
    .join(' ');
}

function blocked(item: HuangguoItem): boolean {
  return (
    isUnderageLabel(item.title) ||
    isUnderageLabel(tagText(item)) ||
    isUnderageLabel(item.description)
  );
}

async function getJson(url: string, timeoutMs = 12000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: HEADERS,
      signal: controller.signal,
      // 列表和详情 JSON 进 Cloudflare 子请求缓存。播放地址不走这里。
      cf: {
        cacheEverything: true,
        cacheTtl: 900,
        cacheTtlByStatus: {
          '200-299': 900,
          '400-499': 30,
          '500-599': 0,
        },
      },
    } as RequestInit);
    if (!response.ok) {
      throw new Error(`黄果请求失败 ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function toCard(item: HuangguoItem): HuangguoCard {
  const count = Number(item.episode_count || item.total_episodes || 0);
  return {
    id: String(item.id || ''),
    title: String(item.title || '').trim(),
    poster: coverPath(String(item.cover || '')),
    episodes: [],
    episode_count: count > 0 ? count : undefined,
    source: 'huangguo',
    source_name: '黄果',
    year: '',
  };
}

function readPage(data: unknown, page: number) {
  const box =
    (
      data as {
        data?: {
          items?: HuangguoItem[];
          pagination?: { page?: number; pages?: number };
        };
      }
    )?.data || {};
  const items = (Array.isArray(box.items) ? box.items : []).filter(
    (item: HuangguoItem) => item?.id && !blocked(item)
  );
  const pagination = box.pagination || {};
  return {
    list: items.map(toCard),
    page: Number(pagination.page) || page,
    pagecount: Number(pagination.pages) || 1,
  };
}

export async function listHuangguo(category: string, page: number) {
  const pageNo = Math.max(1, Math.floor(page || 1));
  const sortCategory = category || 'hot';
  const url =
    sortCategory === 'hot' || sortCategory === 'new'
      ? `${API}/api/videos?page=${pageNo}&size=20&page_size=20&sort=${
          sortCategory === 'new' ? 'new' : 'hot'
        }`
      : `${API}/api/videos/category/${encodeURIComponent(
          sortCategory
        )}?page=${pageNo}&size=20&sort=latest`;
  return readPage(await getJson(url), pageNo);
}

export async function searchHuangguo(query: string, page: number) {
  const pageNo = Math.max(1, Math.floor(page || 1));
  const url = `${API}/api/search?q=${encodeURIComponent(query)}&page=${pageNo}`;
  return readPage(await getJson(url), pageNo);
}

async function playUrl(id: string, episode: number): Promise<string> {
  try {
    const data = (await getJson(
      `${API}/api/videos/${id}/play?ep=${episode}`,
      8000
    )) as { data?: { video_url?: string }; video_url?: string };
    const url = data?.data?.video_url || data?.video_url || '';
    return typeof url === 'string' ? url : '';
  } catch {
    return '';
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await worker(items[index]);
      }
    }
  );
  await Promise.all(runners);
  return output;
}

export async function detailHuangguo(id: string) {
  if (!/^\d+$/.test(id)) {
    throw new Error('无效的视频ID');
  }
  const data = (await getJson(`${API}/api/videos/${id}`)) as {
    data?: HuangguoItem;
  };
  const detail = data?.data || {};
  if (!detail.id || blocked(detail)) {
    throw new Error('内容不可用');
  }
  const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
  const urls = (
    await mapPool(episodes, 4, async (episode) => {
      const number = Number(episode.ep_num || episode.episode || 0);
      if (!number) return '';
      return playUrl(id, number);
    })
  ).filter(Boolean);
  if (urls.length === 0 && detail.video_url) {
    urls.push(detail.video_url);
  }
  return {
    id,
    title: detail.title || id,
    poster: coverPath(detail.cover || ''),
    episodes: urls,
    source: 'huangguo',
    source_name: '黄果',
    class: tagText(detail),
    year: 'unknown',
    desc: detail.description || '',
    type_name: '短剧',
    douban_id: 0,
  };
}
