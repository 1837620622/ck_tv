// 提前做一些不影响当前页面的准备，让下一步更快。

// 省流量模式或 2G 网络下不做任何预取
export function canPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (!connection) return true;
  if (connection.saveData) return false;
  return !/(^|-)2g$/.test(connection.effectiveType || '');
}

// 浏览器空闲时执行；Safari 没有 requestIdleCallback，退回到延时
export function whenIdle(task: () => void, fallbackMs = 2000): () => void {
  const host = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (host.requestIdleCallback) {
    const id = host.requestIdleCallback(task, { timeout: fallbackMs * 2 });
    return () => host.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, fallbackMs);
  return () => window.clearTimeout(id);
}

// 本集快结束时调用：提前请求下一集的播放清单。
// 让片源 CDN 先把清单拉到边缘、连接保持热的，点下一集或自动连播时起播更快。
// no-cors 只为发出请求，不读内容，也不会因为片源没开跨域而在控制台报错。
export function shouldWarmNextEpisode(current: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return duration - current <= 120 || current / duration >= 0.85;
}

export function warmPlaylist(url: string): void {
  if (!/^https?:\/\//i.test(url) || !canPrefetch()) return;
  fetch(url, { mode: 'no-cors', credentials: 'omit' }).catch(() => undefined);
}
