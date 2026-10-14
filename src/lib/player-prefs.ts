// 播放器的个人偏好，存在本机浏览器里。读写失败（隐私模式、被禁用存储）时用默认值，不抛错。

const VOLUME_KEY = 'player_volume';
const AUTO_NEXT_KEY = 'player_auto_next';

export const DEFAULT_VOLUME = 0.7;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readVolume(store: Storage | null = storage()): number {
  try {
    const raw = store?.getItem(VOLUME_KEY);
    if (raw === null || raw === undefined) return DEFAULT_VOLUME;
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_VOLUME;
    return Math.min(1, Math.max(0, value));
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function writeVolume(value: number, store: Storage | null = storage()) {
  if (!Number.isFinite(value)) return;
  try {
    store?.setItem(VOLUME_KEY, String(Math.min(1, Math.max(0, value))));
  } catch {
    // 存不下就算了，下次打开用默认音量
  }
}

// 默认开启自动连播，只有明确关掉过才是关
export function readAutoNext(store: Storage | null = storage()): boolean {
  try {
    return store?.getItem(AUTO_NEXT_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeAutoNext(
  enabled: boolean,
  store: Storage | null = storage()
) {
  try {
    store?.setItem(AUTO_NEXT_KEY, enabled ? '1' : '0');
  } catch {
    // 同上
  }
}
