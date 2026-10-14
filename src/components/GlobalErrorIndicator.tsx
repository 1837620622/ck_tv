'use client';

import { useEffect, useRef, useState } from 'react';

// 错误提示停留的时间；不自动关闭的话，它会一直盖住右上角的主题和用户按钮
const AUTO_HIDE_MS = 6000;
const REPLACE_ANIMATION_MS = 200;

interface ErrorInfo {
  id: string;
  message: string;
  timestamp: number;
}

export function GlobalErrorIndicator() {
  const [currentError, setCurrentError] = useState<ErrorInfo | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const visibleRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replaceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (replaceTimerRef.current) clearTimeout(replaceTimerRef.current);
    hideTimerRef.current = null;
    replaceTimerRef.current = null;
  };

  const handleClose = () => {
    clearTimers();
    visibleRef.current = false;
    setIsVisible(false);
    setCurrentError(null);
    setIsReplacing(false);
  };

  useEffect(() => {
    // 监听自定义错误事件
    const handleError = (event: Event) => {
      const { message } = (event as CustomEvent<{ message: string }>).detail;
      const now = Date.now();
      setCurrentError({ id: now.toString(), message, timestamp: now });

      // 已经在显示时换成新内容，做一次替换动画
      if (visibleRef.current) {
        setIsReplacing(true);
        if (replaceTimerRef.current) clearTimeout(replaceTimerRef.current);
        replaceTimerRef.current = setTimeout(() => {
          setIsReplacing(false);
        }, REPLACE_ANIMATION_MS);
      }
      visibleRef.current = true;
      setIsVisible(true);

      // 每条新错误都重新计时
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(handleClose, AUTO_HIDE_MS);
    };

    // 监听错误事件
    window.addEventListener('globalError', handleError);
    return () => {
      window.removeEventListener('globalError', handleError);
      clearTimers();
    };
    // handleClose 只用到 setState 和 ref，不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isVisible || !currentError) {
    return null;
  }

  return (
    <div className='fixed top-4 right-4 z-[2000]'>
      {/* 错误卡片 */}
      <div
        role='alert'
        className={`bg-red-500 text-white px-4 py-3 rounded-lg shadow-lg flex items-center justify-between min-w-[300px] max-w-[400px] transition-all duration-300 ${
          isReplacing ? 'scale-105 bg-red-400' : 'scale-100 bg-red-500'
        } animate-fade-in`}
      >
        <span className='text-sm font-medium flex-1 mr-3'>
          {currentError.message}
        </span>
        <button
          onClick={handleClose}
          className='text-white hover:text-red-100 transition-colors flex-shrink-0'
          aria-label='关闭错误提示'
        >
          <svg
            className='w-5 h-5'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2}
              d='M6 18L18 6M6 6l12 12'
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

// 全局错误触发函数
export function triggerGlobalError(message: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('globalError', {
        detail: { message },
      })
    );
  }
}
