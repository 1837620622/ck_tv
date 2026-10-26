'use client';

import { useEffect } from 'react';

import { isChunkLoadError, reloadOnce } from '@/lib/app-health';

// 页面出错时代替 Next.js 默认的白屏提示。
// 新版本上线导致旧脚本取不到时，先自动刷新一次；还不行再让访客自己点。
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isChunkLoadError(error);

  useEffect(() => {
    if (stale) reloadOnce();
  }, [stale]);

  return (
    <div className='flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center'>
      <p className='text-base font-medium text-gray-800 dark:text-gray-100'>
        {stale ? '网站刚更新过，正在加载新版本' : '页面没有加载成功'}
      </p>
      <p className='text-sm text-gray-500 dark:text-gray-400'>
        网络不稳时常见。可以重试，或者刷新整个页面。
      </p>
      <div className='flex gap-3'>
        <button
          type='button'
          onClick={() => reset()}
          className='rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200'
        >
          重试
        </button>
        <button
          type='button'
          onClick={() => window.location.reload()}
          className='rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700'
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}
