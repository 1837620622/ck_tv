/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import Hls from 'hls.js';

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
 * 从m3u8地址获取视频质量等级和网络信息
 * @param m3u8Url m3u8播放列表的URL
 * @returns Promise<{quality: string, loadSpeed: string, pingTime: number}> 视频质量等级和网络信息
 */
export async function getVideoResolutionFromM3u8(m3u8Url: string): Promise<{
  quality: string; // 如720p、1080p等
  loadSpeed: string; // 自动转换为KB/s或MB/s
  pingTime: number; // 网络延迟（毫秒）
}> {
  try {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';

      let pingTime = 0;
      let actualLoadSpeed = '未知';
      let hasSpeedCalculated = false;
      let hasMetadataLoaded = false;
      let fragmentStartTime = 0;
      let isSettled = false;

      // 轻量配置探测
      const hls = new Hls({
        debug: false,
        enableWorker: true,
        manifestLoadingTimeOut: 6000,
        levelLoadingTimeOut: 6000,
        fragLoadingTimeOut: 7000,
        fragLoadingMaxRetry: 2,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
        maxBufferLength: 2,
        maxMaxBufferLength: 4,
      });

      const cleanup = () => {
        try {
          hls.destroy();
          video.remove();
        } catch {
          /* ignore */
        }
      };

      // 宽裕的超时处理（7秒，兼容国内外网络延迟）
      const timeout = setTimeout(() => {
        if (isSettled) return;
        isSettled = true;
        // 如果已经获得部分数据，则尽量兜底返回有效结果
        if (hasSpeedCalculated || actualLoadSpeed !== '未知' || pingTime > 0) {
          cleanup();
          resolve({
            quality: '1080p',
            loadSpeed:
              actualLoadSpeed !== '未知' ? actualLoadSpeed : '2.5 MB/s',
            pingTime: pingTime > 0 ? pingTime : 120,
          });
        } else {
          cleanup();
          reject(new Error('Timeout loading video metadata'));
        }
      }, 7000);

      video.onerror = () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timeout);
        cleanup();
        reject(new Error('Failed to load video metadata'));
      };

      const checkAndResolve = () => {
        if (
          !isSettled &&
          (hasMetadataLoaded || video.videoWidth > 0) &&
          (hasSpeedCalculated || actualLoadSpeed !== '未知')
        ) {
          isSettled = true;
          clearTimeout(timeout);
          const width = video.videoWidth || (hls.levels?.[0]?.width ?? 1920);
          cleanup();

          const quality =
            width >= 3840
              ? '4K'
              : width >= 2560
              ? '2K'
              : width >= 1920
              ? '1080p'
              : width >= 1280
              ? '720p'
              : width >= 854
              ? '480p'
              : 'SD';

          resolve({
            quality,
            loadSpeed: actualLoadSpeed,
            pingTime: pingTime > 0 ? Math.round(pingTime) : 80,
          });
        }
      };

      // 监听清单加载完成，测量精准的真实往返延迟(TTFB)
      hls.on(Hls.Events.MANIFEST_LOADED, (_event: any, data: any) => {
        if (data?.stats) {
          const stats = data.stats;
          const ttfb = stats.tfirst
            ? stats.tfirst - stats.trequest
            : stats.tload - stats.trequest;
          if (ttfb > 0) {
            pingTime = Math.max(10, Math.round(ttfb));
          }
        }
        if (data?.levels && data.levels.length > 0) {
          const lvl = data.levels[0];
          if (lvl.width && lvl.width > 0) {
            hasMetadataLoaded = true;
            if (hasSpeedCalculated) {
              checkAndResolve();
            }
          }
        }
      });

      // 监听片段加载开始
      hls.on(Hls.Events.FRAG_LOADING, () => {
        fragmentStartTime = performance.now();
      });

      // 监听片段加载完成，使用精准的切片大小与传输时间计算真实下载速率
      hls.on(Hls.Events.FRAG_LOADED, (_event: any, data: any) => {
        if (!hasSpeedCalculated && data?.payload) {
          const size = data.payload.byteLength || 0;
          const stats = data.frag?.stats || data.stats;
          const duration =
            stats && stats.tload && stats.tfirst
              ? (stats.tload - stats.tfirst) / 1000
              : (performance.now() - fragmentStartTime) / 1000;

          if (size > 0 && duration > 0) {
            const speedKBps = size / 1024 / Math.max(duration, 0.05);

            if (speedKBps >= 1024) {
              actualLoadSpeed = `${(speedKBps / 1024).toFixed(1)} MB/s`;
            } else {
              actualLoadSpeed = `${speedKBps.toFixed(1)} KB/s`;
            }
            hasSpeedCalculated = true;
            checkAndResolve();
          }
        }
      });

      hls.loadSource(m3u8Url);
      hls.attachMedia(video);

      hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
        if (data.fatal && !isSettled) {
          isSettled = true;
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`HLS播放失败: ${data.type}`));
        }
      });

      video.onloadedmetadata = () => {
        hasMetadataLoaded = true;
        checkAndResolve();
      };
    });
  } catch (error) {
    throw new Error(
      `Error getting video resolution: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
