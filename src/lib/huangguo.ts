import { allowedCoverUrl } from '@/lib/huangguo-image';
import { huangguoPlaylistPath } from '@/lib/huangguo-media';
import { fetchPublic, publicHttpUrl } from '@/lib/safe-url';
import { isUnderageLabel } from '@/lib/yellow';

const API = 'https://huangguoai.com';

function coverPath(url: string): string {
  const allowed = allowedCoverUrl(url.trim());
  if (!allowed) return '';
  return `/api/huangguo/cover?u=${encodeURIComponent(allowed)}`;
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
      // 列表和详情可以缓存。播放地址签名只有几秒，不能走这里。
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

function episodeNumbers(detail: HuangguoItem): number[] {
  const episodes = Array.isArray(detail.episodes) ? detail.episodes : [];
  const numbers = episodes
    .map((episode) => Number(episode.ep_num || episode.episode || 0))
    .filter((episode) => Number.isInteger(episode) && episode > 0);
  if (numbers.length === 0 && detail.video_url) return [1];
  return numbers;
}

async function loadDetail(id: string): Promise<HuangguoItem | null> {
  const data = (await getJson(`${API}/api/videos/${id}`)) as {
    data?: HuangguoItem;
  };
  const detail = data?.data || {};
  if (!detail.id || blocked(detail)) return null;
  return detail;
}

// 最近一次播放地址失败原因。同一次请求里写完立刻读，不跨请求保存。
let playWhy = '';

export function huangguoPlayWhy(): string {
  return playWhy;
}

// 播放接口的签名不能进缓存。响应里的密钥字段也不往外带。
// 边缘运行时不要带 cache 模式：和 cf 一起用时，有的运行时会直接丢掉这次请求。
async function freshPlayUrl(id: string, episode: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${API}/api/videos/${id}/play?ep=${episode}`, {
      headers: HEADERS,
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
    if (!response.ok) {
      playWhy = `play-${response.status}`;
      return '';
    }
    const data = (await response.json()) as {
      data?: { video_url?: string };
      video_url?: string;
    };
    const url = data?.data?.video_url || data?.video_url || '';
    if (typeof url !== 'string' || !url) {
      playWhy = 'play-empty';
      return '';
    }
    return url;
  } catch {
    playWhy = 'play-error';
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function playlistUrl(raw: string): URL | null {
  const parsed = publicHttpUrl(raw);
  if (!parsed || parsed.protocol !== 'https:') return null;
  if (!parsed.pathname.toLowerCase().endsWith('.m3u8')) return null;
  return parsed;
}

export async function readHuangguoPlayTarget(
  id: string,
  episode: number
): Promise<string> {
  if (
    !/^\d{1,12}$/.test(id) ||
    !Number.isInteger(episode) ||
    episode < 1 ||
    episode > 9999
  ) {
    playWhy = 'bad-id';
    return '';
  }
  playWhy = '';
  let detail: HuangguoItem | null = null;
  try {
    detail = await loadDetail(id);
  } catch {
    playWhy = 'detail-error';
    return '';
  }
  if (!detail) {
    playWhy = 'detail-miss';
    return '';
  }
  if (!episodeNumbers(detail).includes(episode)) {
    playWhy = 'episode-miss';
    return '';
  }
  const raw = await freshPlayUrl(id, episode);
  if (!raw) return '';
  const target = playlistUrl(raw);
  if (!target) {
    playWhy = 'bad-url';
    return '';
  }
  playWhy = 'ok';
  return target.toString();
}

const MAX_PLAYLIST_CHARS = 512 * 1024;

// 清单正文必须整份都是绝对地址。相对地址会被播放器拼到本站，分片不能进这里。
function absolutePlaylist(text: string): boolean {
  if (!text.startsWith('#EXTM3U')) return false;
  let segments = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith('https://')) return false;
    segments += 1;
  }
  return segments > 0;
}

// 播放器要的是这一集的清单正文，不是跳转。
// 出站不要带 cf：带 cacheTtl 时，边缘曾把同一主机上不同集收成同一份。
export async function readHuangguoPlaylist(
  id: string,
  episode: number
): Promise<string> {
  const target = await readHuangguoPlayTarget(id, episode);
  if (!target) return '';
  const playlist = playlistUrl(target);
  if (!playlist) {
    playWhy = 'bad-url';
    return '';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchPublic(playlist, {
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, */*',
        'User-Agent': HEADERS['User-Agent'],
        Referer: HEADERS.Referer,
      },
      signal: controller.signal,
    });
    if (!response) {
      playWhy = 'list-blocked';
      return '';
    }
    if (!response.ok) {
      playWhy = `list-${response.status}`;
      return '';
    }
    const text = (await response.text()).replace(/^\uFEFF/, '');
    if (text.length > MAX_PLAYLIST_CHARS || !absolutePlaylist(text)) {
      playWhy = 'list-bad';
      return '';
    }
    playWhy = 'ok';
    return text;
  } catch {
    playWhy = 'list-error';
    return '';
  } finally {
    clearTimeout(timer);
  }
}

export async function detailHuangguo(id: string) {
  if (!/^\d{1,12}$/.test(id)) {
    throw new Error('无效的视频ID');
  }
  const detail = await loadDetail(id);
  if (!detail) {
    throw new Error('内容不可用');
  }
  const numbers = episodeNumbers(detail);
  return {
    id,
    title: detail.title || id,
    poster: coverPath(detail.cover || ''),
    episodes: numbers.map((episode) => huangguoPlaylistPath(id, episode)),
    source: 'huangguo',
    source_name: '黄果',
    class: tagText(detail),
    year: 'unknown',
    desc: detail.description || '',
    type_name: '短剧',
    douban_id: 0,
  };
}
