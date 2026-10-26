/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { playlistHeight, qualityText } from '@/lib/playlist';

/**
 * 获取图片代理 URL 设置
 */
export function getImageProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 本地未开启图片代理，则不使用代理
  const enableImageProxy = localStorage.getItem('enableImageProxy');
  if (enableImageProxy !== null) {
    if (!JSON.parse(enableImageProxy) as boolean) {
      return null;
    }
  }

  const localImageProxy = localStorage.getItem('imageProxyUrl');
  if (localImageProxy != null) {
    return localImageProxy.trim() ? localImageProxy.trim() : null;
  }

  // 如果未设置，则使用全局对象
  const serverImageProxy = (window as any).RUNTIME_CONFIG?.IMAGE_PROXY;
  return serverImageProxy && serverImageProxy.trim()
    ? serverImageProxy.trim()
    : null;
}

// 豆瓣图床在国内。时区在中国大陆、港澳台的访客直连更快：走本站代理要先绕到 Cloudflare 节点
// （国内访客常被分到美国西部），每张图还要启动一次函数。其他地区仍走代理，代理结果按节点缓存。
const NEAR_DOUBAN_TIME_ZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Chungking',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Kashgar',
  'Asia/Hong_Kong',
  'Asia/Macau',
  'Asia/Taipei',
  'PRC',
  'ROC',
  'Hongkong',
]);

export function isNearDoubanCdn(timeZone: string | undefined): boolean {
  return !!timeZone && NEAR_DOUBAN_TIME_ZONES.has(timeZone);
}

function visitorTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * 海报卡片用的图片地址。只给有失败回退的地方用（VideoCard 加载失败会改走 /api/image-proxy）：
 * 国内时区的豆瓣海报直连，其余和 processImageUrl 相同。页面已经设了 no-referrer，豆瓣不会因为来源拦截。
 */
export function posterImageUrl(
  originalUrl: string,
  timeZone: string | undefined = visitorTimeZone()
): string {
  const cleanUrl = (originalUrl || '').trim();
  if (cleanUrl.includes('doubanio.com') && isNearDoubanCdn(timeZone)) {
    return cleanUrl.replace(/^http:\/\//, 'https://');
  }
  return processImageUrl(originalUrl);
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 * 豆瓣图片会自动使用内置代理绕过防盗链
 */
export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return '';
  const cleanUrl = originalUrl.trim();
  if (!cleanUrl) return '';

  if (cleanUrl.startsWith('/')) return cleanUrl;

  // 检测是否为豆瓣图片（doubanio.com 域名有防盗链保护）
  const isDoubanImage = cleanUrl.includes('doubanio.com');
  if (isDoubanImage) {
    return `/api/image-proxy?url=${encodeURIComponent(cleanUrl)}`;
  }

  // 针对已知防盗链严重且常403的图片域名（如暴风、极速、电影天堂等部分CDN），自动走内置代理保证可用
  if (
    cleanUrl.includes('bfvp26.com') ||
    cleanUrl.includes('bfzypic.com') ||
    cleanUrl.includes('img.bfzypic.com') ||
    cleanUrl.includes('dytt-tupian.com')
  ) {
    return `/api/image-proxy?url=${encodeURIComponent(cleanUrl)}`;
  }

  // 其他图片使用用户配置的代理（如果有）
  const proxyUrl = getImageProxyUrl();
  if (proxyUrl) {
    return `${proxyUrl}${encodeURIComponent(cleanUrl)}`;
  }

  // 若为 http 图片，在 https 站点下升级为 https 防止混合内容拦截
  if (
    cleanUrl.startsWith('http://') &&
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:'
  ) {
    return cleanUrl.replace('http://', 'https://');
  }

  return cleanUrl;
}

/**
 * 获取豆瓣代理 URL 设置
 */
export function getDoubanProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 本地未开启豆瓣代理，则不使用代理
  const enableDoubanProxy = localStorage.getItem('enableDoubanProxy');
  if (enableDoubanProxy !== null) {
    if (!JSON.parse(enableDoubanProxy) as boolean) {
      return null;
    }
  }

  const localDoubanProxy = localStorage.getItem('doubanProxyUrl');
  if (localDoubanProxy != null) {
    return localDoubanProxy.trim() ? localDoubanProxy.trim() : null;
  }

  // 如果未设置，则使用全局对象
  const serverDoubanProxy = (window as any).RUNTIME_CONFIG?.DOUBAN_PROXY;
  return serverDoubanProxy && serverDoubanProxy.trim()
    ? serverDoubanProxy.trim()
    : null;
}

/**
 * 处理豆瓣 URL，如果设置了豆瓣代理则使用代理
 */
export function processDoubanUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getDoubanProxyUrl();
  if (!proxyUrl) return originalUrl;

  return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
}

export function cleanHtmlTags(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .replace(/&nbsp;/g, ' ') // 将 &nbsp; 替换为空格
    .trim(); // 去掉首尾空格
}

/**
 * 只读取 m3u8 清单，测量往返并解析清晰度。不创建播放器，不下载正片。
 */
export async function getVideoResolutionFromM3u8(m3u8Url: string): Promise<{
  quality: string;
  loadSpeed: string;
  pingTime: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  const started = performance.now();
  try {
    const response = await fetch(m3u8Url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (!body.includes('#EXTM3U')) throw new Error('不是 m3u8 清单');
    return {
      quality: qualityText(playlistHeight(body)) || '未知',
      loadSpeed: '未下载正片',
      pingTime: Math.max(1, Math.round(performance.now() - started)),
    };
  } finally {
    clearTimeout(timer);
  }
}
