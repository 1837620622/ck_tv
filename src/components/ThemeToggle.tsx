/* eslint-disable @typescript-eslint/no-explicit-any,react-hooks/exhaustive-deps */

'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

// 根据时间判断应该使用的主题
// 早上6点到晚上18点使用亮色主题，其他时间使用暗色主题
const getThemeByTime = (): 'light' | 'dark' => {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18 ? 'light' : 'dark';
};

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const { setTheme, resolvedTheme, theme } = useTheme();

  const setThemeColor = (themeValue?: string) => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      const newMeta = document.createElement('meta');
      newMeta.name = 'theme-color';
      newMeta.content = themeValue === 'dark' ? '#0c111c' : '#f9fbfe';
      document.head.appendChild(newMeta);
    } else {
      meta.setAttribute('content', themeValue === 'dark' ? '#0c111c' : '#f9fbfe');
    }
  };

  useEffect(() => {
    setMounted(true);

    // 检查是否是首次访问（没有手动设置过主题）
    const hasManualTheme = localStorage.getItem('theme-manual');

    if (!hasManualTheme) {
      // 首次访问或未手动切换过，根据时间自动设置主题
      const autoTheme = getThemeByTime();
      setTheme(autoTheme);
      setThemeColor(autoTheme);
    } else {
      setThemeColor(resolvedTheme);
    }

    // 每分钟检查一次时间，自动切换主题（仅在未手动设置时）
    const interval = setInterval(() => {
      const hasManual = localStorage.getItem('theme-manual');
      if (!hasManual) {
        const autoTheme = getThemeByTime();
        if (autoTheme !== resolvedTheme) {
          setTheme(autoTheme);
          setThemeColor(autoTheme);
        }
      }
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  if (!mounted) {
    // 渲染一个占位符以避免布局偏移
    return <div className='w-10 h-10' />;
  }

  const toggleTheme = () => {
    // 用户手动切换主题，标记为手动设置
    localStorage.setItem('theme-manual', 'true');

    const targetTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    setThemeColor(targetTheme);

    // 检查浏览器是否支持 View Transitions API
    if (!(document as any).startViewTransition) {
      setTheme(targetTheme);
      return;
    }

    (document as any).startViewTransition(() => {
      setTheme(targetTheme);
    });
  };

  // 重置为自动模式（双击主题按钮）
  const resetToAuto = () => {
    localStorage.removeItem('theme-manual');
    const autoTheme = getThemeByTime();
    setTheme(autoTheme);
    setThemeColor(autoTheme);
  };

  return (
    <button
      onClick={toggleTheme}
      className='w-10 h-10 p-2 rounded-full flex items-center justify-center text-gray-600 hover:bg-gray-200/50 dark:text-gray-300 dark:hover:bg-gray-700/50 transition-colors'
      aria-label='Toggle theme'
    >
      {resolvedTheme === 'dark' ? (
        <Sun className='w-full h-full' />
      ) : (
        <Moon className='w-full h-full' />
      )}
    </button>
  );
}
