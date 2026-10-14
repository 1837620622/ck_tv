'use client';

import { Heart, Sparkles, X } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const WelcomeModal: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [coversPager, setCoversPager] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // 翻页条被卡片盖住时收起，让人能点到翻页。直接比较两个矩形，不依赖页面用的是 body 还是 window 滚动，
  // 也不管页面长短；翻页条不在屏幕上或不存在时卡片照常显示。
  useEffect(() => {
    if (!isOpen) return;
    const update = () => {
      const pager = document.querySelector('nav[aria-label="翻页"]');
      const card = cardRef.current;
      if (!pager || !card) {
        setCoversPager(false);
        return;
      }
      const p = pager.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      setCoversPager(
        p.bottom > c.top &&
          p.top < c.bottom &&
          p.right > c.left &&
          p.left < c.right
      );
    };
    update();
    // capture：页面里任何一个滚动容器（body 或其它）滚动都会触发
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    // 翻页条和卡片本身的内容（展开赞赏码、列表异步加载）变化后也要重新判断
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
      observer.disconnect();
    };
  }, [isOpen]);

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
    <div
      ref={cardRef}
      className={`fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] md:bottom-6 right-4 sm:right-6 z-[999] max-w-sm w-[calc(100%-2rem)] sm:w-80 transition-all duration-300 ${
        coversPager
          ? 'pointer-events-none invisible translate-y-2 opacity-0'
          : 'opacity-100'
      }`}
    >
      {/* 悬浮卡片 - 不遮挡全屏，不强制倒计时；盖住翻页条时自动收起 */}
      <div className='relative animate-slide-up overflow-hidden border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950'>
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
        <p className='text-[11px] leading-relaxed text-gray-600 dark:text-gray-400'>
          免责声明：本站资源均来自公开互联网接口，仅供学习与技术交流。本站不存储、不制作。
        </p>

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
          <div className='mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 text-center animate-fade-in'>
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
