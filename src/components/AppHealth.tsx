'use client';

import { useEffect } from 'react';

import {
  clearLegacyCaches,
  isChunkLoadError,
  reloadOnce,
} from '@/lib/app-health';

// 挂在根布局里，不渲染任何东西：
// - 新版本上线后旧页面加载旧脚本失败时，自动刷新一次；
// - 删掉旧版 Service Worker 留下的运行时缓存。
export function AppHealth() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      if (isChunkLoadError(event.error) || isChunkLoadError(event.message)) {
        reloadOnce();
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) reloadOnce();
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    // 等首屏加载完再清，不和页面抢 I/O
    const timer = window.setTimeout(() => {
      clearLegacyCaches().catch(() => undefined);
    }, 5000);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearTimeout(timer);
    };
  }, []);

  return null;
}
