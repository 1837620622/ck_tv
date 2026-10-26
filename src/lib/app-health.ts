// 新版本上线后，还开着的旧页面会去要旧版本的脚本。Cloudflare Pages 换版本后旧文件就没了，
// 脚本加载失败，页面卡在加载中或白屏。遇到这种错误刷新一次，拿到新版本的页面。

const RELOAD_KEY = 'ck-chunk-reload-at';
// 一分钟内只自动刷新一次，新版本本身有问题时不会陷入刷新循环
const RELOAD_COOLDOWN_MS = 60 * 1000;

const CHUNK_ERROR_PATTERNS = [
  /Loading chunk [\w-]+ failed/i,
  /Loading CSS chunk [\w-]+ failed/i,
  /ChunkLoadError/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

export function isChunkLoadError(reason: unknown): boolean {
  if (!reason) return false;
  const named = reason as { name?: unknown; message?: unknown };
  if (named.name === 'ChunkLoadError') return true;
  const message =
    typeof reason === 'string'
      ? reason
      : typeof named.message === 'string'
      ? named.message
      : '';
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

type ReloadDeps = {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload: () => void;
  now: number;
};

// 返回 true 表示已经安排刷新。拿不到 sessionStorage 时不自动刷新：没法记住刷新过，可能一直刷。
export function reloadOnce(deps?: Partial<ReloadDeps>): boolean {
  const now = deps?.now ?? Date.now();
  const reload = deps?.reload ?? (() => window.location.reload());
  let storage: ReloadDeps['storage'] = null;
  try {
    storage =
      deps?.storage !== undefined ? deps.storage : window.sessionStorage;
  } catch {
    storage = null;
  }
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_KEY) || 0);
    if (now - last < RELOAD_COOLDOWN_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

// 旧版本 Service Worker 的运行时缓存：接口、页面、跨域请求（包括视频分片）都会写进来。
// 新的 Service Worker 不再用它们，留着只占空间，这里删掉。
export const LEGACY_SW_CACHES = [
  'apis',
  'others',
  'cross-origin',
  'start-url',
  'next-data',
  'next-image',
  'static-js-assets',
  'static-style-assets',
  'static-data-assets',
  'static-image-assets',
  'static-font-assets',
  'static-audio-assets',
  'static-video-assets',
  'google-fonts-webfonts',
  'google-fonts-stylesheets',
];

export async function clearLegacyCaches(
  store: Pick<CacheStorage, 'keys' | 'delete'> | undefined = typeof caches ===
  'undefined'
    ? undefined
    : caches
): Promise<number> {
  if (!store) return 0;
  const names = await store.keys();
  const legacy = names.filter((name) => LEGACY_SW_CACHES.includes(name));
  await Promise.all(legacy.map((name) => store.delete(name)));
  return legacy.length;
}
