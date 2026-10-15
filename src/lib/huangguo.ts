import { allowedCoverUrl } from '@/lib/huangguo-image';
import { huangguoPlaylistPath } from '@/lib/huangguo-media';
import { fetchPublic, publicHttpUrl } from '@/lib/safe-url';
import { isUnderageLabel } from '@/lib/yellow';

const API = 'https://huangguoai.com';
const MAX_PLAYLIST_BYTES = 1_000_000;

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

async function readPlaylistBody(
  response: Response
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_PLAYLIST_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PLAYLIST_BYTES) {
    return null;
  }
  if (!startsWithPlaylist(bytes)) return null;
  return bytes;
}

// 只认 #EXTM3U，允许前面有 BOM 和空白。不用 TextDecoder，测试环境和边缘运行时都一样。
function startsWithPlaylist(bytes: Uint8Array): boolean {
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  while (
    bytes[offset] === 0x20 ||
    bytes[offset] === 0x09 ||
    bytes[offset] === 0x0a ||
    bytes[offset] === 0x0d
  ) {
    offset += 1;
  }
  const magic = [0x23, 0x45, 0x58, 0x54, 0x4d, 0x33, 0x55];
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

// 把刚拿到的清单原文交回播放器。分片地址留在清单里，不经过本站。
export async function readHuangguoPlaylist(
  id: string,
  episode: number
): Promise<Uint8Array | null> {
  const target = playlistUrl(await readHuangguoPlayTarget(id, episode));
  if (!target) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchPublic(target, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        Referer: 'https://huangguoai.com/',
        'User-Agent': HEADERS['User-Agent'],
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
    if (!response || !response.ok) {
      playWhy = response ? `list-${response.status}` : 'list-blocked';
      return null;
    }
    const bytes = await readPlaylistBody(response);
    if (!bytes) playWhy = 'list-body';
    return bytes;
  } catch {
    playWhy = 'list-error';
    return null;
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
