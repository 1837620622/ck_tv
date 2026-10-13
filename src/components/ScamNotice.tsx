'use client';

import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';

// 用户关闭后，这段时间内不再显示
const HIDE_KEY = 'scam-notice-hidden-until';
const HIDE_MS = 7 * 24 * 60 * 60 * 1000;

// 存储不可用（隐私模式、被禁用）时视为未关闭，每次都显示，不影响播放
export function isNoticeHidden(now = Date.now()): boolean {
  try {
    const until = Number(window.localStorage.getItem(HIDE_KEY) || 0);
    return until > now;
  } catch {
    return false;
  }
}

export function hideNotice(now = Date.now()): void {
  try {
    window.localStorage.setItem(HIDE_KEY, String(now + HIDE_MS));
  } catch {
    // 存储不可用时只是本次关不掉，下次打开仍会显示
  }
}

// 防诈骗提醒：视频画面里的广告、水印和弹窗都不是本站内容，提醒用户不要相信、不要转账
export default function ScamNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(!isNoticeHidden());
  }, []);

  if (!visible) return null;

  return (
    <div
      role='note'
      className='mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100'
    >
      <ShieldAlert className='mt-0.5 h-5 w-5 shrink-0' aria-hidden='true' />
      <div className='flex-1 text-sm leading-relaxed'>
        <p className='font-semibold'>防诈骗提醒</p>
        <p>
          视频画面中的广告、水印和弹窗（如赌博、炸金花、色情、刷单、贷款、下载陌生
          App
          等）都与本站无关，请勿相信。不要添加陌生人的联系方式，不要转账或输入账号密码。遇到可疑内容请关闭并举报。
        </p>
      </div>
      <button
        type='button'
        aria-label='关闭提醒'
        onClick={() => {
          hideNotice();
          setVisible(false);
        }}
        className='shrink-0 rounded p-1 text-amber-700 transition-colors hover:bg-amber-100 hover:text-amber-900 dark:text-amber-300 dark:hover:bg-amber-800/50'
      >
        <X className='h-4 w-4' />
      </button>
    </div>
  );
}
