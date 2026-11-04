'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function BackButton() {
  const router = useRouter();

  const handleBack = () => {
    // 从搜索列表点进播放页时，播放地址里带 from=search + stitle。
    // 直接 history.back() 依赖历史栈：搜索那一步一旦没进栈（直链、分享、
    // 刷新后等），就会越过搜索列表、落到更早的分类页。
    // 这里认准来源：是搜索来的，就用 replace 回到那次搜索的列表，
    // replace 不会新增历史项，从搜索页再按浏览器返回也不会弹回播放页。
    // 不是搜索来的（分类、收藏、首页等），保持原来的 history.back()。
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('from') === 'search') {
        const query = params.get('stitle') || params.get('title') || '';
        if (query) {
          router.replace(`/search?q=${encodeURIComponent(query)}`);
          return;
        }
      }
    } catch {
      // 取不到参数时按原逻辑回退
    }
    window.history.back();
  };

  return (
    <button
      onClick={handleBack}
      className='w-10 h-10 p-2 rounded-full flex items-center justify-center text-gray-600 hover:bg-gray-200/50 dark:text-gray-300 dark:hover:bg-gray-700/50 transition-colors'
      aria-label='Back'
    >
      <ArrowLeft className='w-full h-full' />
    </button>
  );
}
