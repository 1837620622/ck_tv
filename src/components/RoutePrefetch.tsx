'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { canPrefetch, whenIdle } from '@/lib/warm-up';

// 海报卡片用 router.push 跳转，Next.js 不会提前加载目标页。播放页的脚本有 300 多 KB，
// 以前点开海报后才开始下载。页面空闲时先把播放页和搜索页的代码取回来，点开就能直接渲染。
export function RoutePrefetch() {
  const router = useRouter();
  useEffect(() => {
    if (!canPrefetch()) return;
    return whenIdle(() => {
      router.prefetch('/play');
      router.prefetch('/search');
    }, 3000);
  }, [router]);
  return null;
}
