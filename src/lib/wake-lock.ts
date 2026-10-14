// 播放时不让屏幕自动熄灭。浏览器会在页面切到后台时自动释放这个锁，所以回到前台要重新申请。
// 不支持 Screen Wake Lock 的浏览器、或申请被拒绝（比如省电模式），都静默跳过。

interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface ScreenWakeLock {
  enable(): void;
  disable(): void;
}

export function createScreenWakeLock(
  doc: Document | null = typeof document === 'undefined' ? null : document,
  nav: Navigator | null = typeof navigator === 'undefined' ? null : navigator
): ScreenWakeLock {
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  // 正在申请中的请求：这时再 enable 复用它，不再发第二个
  let pending: Promise<void> | null = null;

  const lock = (): WakeLockLike | null =>
    (nav as (Navigator & { wakeLock?: WakeLockLike }) | null)?.wakeLock ?? null;

  const acquire = (): Promise<void> => {
    const api = lock();
    if (!api || !wanted) return Promise.resolve();
    if (pending) return pending;
    if (sentinel && !sentinel.released) return Promise.resolve();
    const started = (async () => {
      try {
        const next = await api.request('screen');
        // 申请期间如果已经被要求停止，立刻放掉，不留锁
        if (!wanted) {
          await next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
      } catch {
        sentinel = null;
      }
    })();
    // 在 then 里清空，保证先把 pending 存下来再清（即使 request 同步抛错也一样）
    pending = started.then(() => {
      pending = null;
    });
    return pending;
  };

  const onVisibility = () => {
    if (doc?.visibilityState === 'visible') void acquire();
  };

  return {
    enable() {
      if (wanted) return;
      wanted = true;
      doc?.addEventListener('visibilitychange', onVisibility);
      void acquire();
    },
    disable() {
      wanted = false;
      doc?.removeEventListener('visibilitychange', onVisibility);
      const current = sentinel;
      sentinel = null;
      current?.release().catch(() => undefined);
    },
  };
}
