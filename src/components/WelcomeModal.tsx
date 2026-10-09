'use client';

import { Heart, Shield, Sparkles, X } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const WelcomeModal: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    setMounted(true);
    // 使用 localStorage 记录，如果用户已关闭过则不再弹出
    const dismissed = localStorage.getItem('hasDismissedWelcomeNotice');
    if (!dismissed) {
      // 延迟 1 秒柔和弹出，不打断用户首屏加载
      const timer = setTimeout(() => {
        setIsOpen(true);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleClose = () => {
    setIsOpen(false);
    localStorage.setItem('hasDismissedWelcomeNotice', 'true');
  };

  if (!mounted || !isOpen) return null;

  return createPortal(
    <div className='fixed bottom-20 md:bottom-6 right-4 sm:right-6 z-[999] max-w-sm w-[calc(100%-2rem)] sm:w-80 transition-all duration-300 animate-in fade-in slide-in-from-bottom-5'>
      {/* 悬浮卡片 - 不遮挡全屏，不强制倒计时 */}
      <div className='relative overflow-hidden border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950'>
        <div className='absolute left-0 right-0 top-0 h-1 bg-green-600' />

        {/* 标题栏 */}
        <div className='flex items-center justify-between pb-2 mb-2 border-b border-gray-100 dark:border-gray-800'>
          <div className='flex items-center gap-2'>
            <div className='w-7 h-7 rounded-lg bg-green-500/10 flex items-center justify-center text-green-600 dark:text-green-400'>
              <Sparkles className='w-4 h-4' />
            </div>
            <h3 className='text-sm font-bold text-gray-900 dark:text-gray-100'>
              欢迎使用 CKTV
            </h3>
          </div>
          <button
            onClick={handleClose}
            className='p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors'
            aria-label='关闭通知'
          >
            <X className='w-4 h-4' />
          </button>
        </div>

        {/* 说明内容 */}
        <div className='space-y-2 text-xs text-gray-600 dark:text-gray-300 leading-relaxed'>
          <p className='flex items-start gap-1.5'>
            <Shield className='w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5' />
            <span>线路按配置顺序起播。测速只看播放清单，不预下载正片。</span>
          </p>
          <p className='text-gray-400 dark:text-gray-500 text-[11px]'>
            本站资源均来自公开互联网接口，仅供学习与技术交流。
          </p>
        </div>

        {/* 底部操作与赞赏按钮 */}
        <div className='mt-3 pt-2.5 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between'>
          <button
            onClick={() => setShowQr(!showQr)}
            className='text-[11px] text-green-600 dark:text-green-400 hover:underline flex items-center gap-1 font-medium'
          >
            <Heart className='w-3 h-3 text-rose-500' />
            {showQr ? '收起赞赏' : '支持作者'}
          </button>
          <button
            onClick={handleClose}
            className='text-xs px-3 py-1 bg-green-500 hover:bg-green-600 text-white rounded-lg font-medium transition-colors shadow-sm'
          >
            知道了
          </button>
        </div>

        {/* 可选展开的赞赏码 */}
        {showQr && (
          <div className='mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 text-center animate-in fade-in duration-200'>
            <div className='w-36 h-36 mx-auto relative rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 shadow-sm'>
              <Image
                src='/ck.jpg'
                alt='赞赏码'
                fill
                sizes='144px'
                className='object-cover'
              />
            </div>
            <p className='text-[10px] text-gray-400 mt-1.5'>
              感谢您的认可与支持！
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
