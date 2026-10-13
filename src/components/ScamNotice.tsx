'use client';

import { ShieldAlert, X } from 'lucide-react';

import { hideNotice, SCAM_NOTICE_HIDDEN_ATTR } from '@/lib/scam-notice';

// 防诈骗提醒：视频画面里的广告、水印和弹窗都不是本站内容。
// 做成单行条，放在标题信息下面，只占一行高度，不挤压播放器和选集。
// 是否已关闭由 layout 里的初始化脚本在首屏前处理，这里不读存储，所以服务端和客户端渲染一致。
export default function ScamNotice() {
  return (
    <div
      data-scam-notice
      role='note'
      className='flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs leading-snug text-amber-900 sm:py-2 sm:text-sm dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100'
    >
      <ShieldAlert className='h-4 w-4 shrink-0' aria-hidden='true' />
      <p className='flex-1'>
        <span className='font-semibold'>防诈骗提醒：</span>
        画面中的赌博、炸金花、色情广告与本站无关，勿相信、勿转账、勿加陌生人。
      </p>
      <button
        type='button'
        aria-label='关闭提醒'
        onClick={() => {
          hideNotice();
          document.documentElement.setAttribute(SCAM_NOTICE_HIDDEN_ATTR, '');
        }}
        className='shrink-0 rounded p-1 text-amber-700 transition-colors hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-800/50'
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  );
}
