/* eslint-disable @typescript-eslint/no-explicit-any */

'use client';

import {
  Clapperboard,
  Clover,
  Film,
  Flame,
  Home,
  Search,
  Sparkles,
  Star,
  Tv,
  Video,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface MobileBottomNavProps {
  /**
   * 主动指定当前激活的路径。当未提供时，自动使用 usePathname() 获取的路径。
   */
  activePath?: string;
}

const MobileBottomNav = ({ activePath }: MobileBottomNavProps) => {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // 构建完整的当前 URL（包含查询参数）
  const currentUrl = searchParams.toString()
    ? `${pathname}?${searchParams.toString()}`
    : pathname;

  // 当前激活路径：优先使用传入的 activePath，否则使用完整 URL
  const currentActive = activePath ?? currentUrl;

  const [navItems, setNavItems] = useState([
    { icon: Home, label: '首页', href: '/' },
    { icon: Search, label: '搜索', href: '/search' },
    { icon: Film, label: '电影', href: '/douban?type=movie' },
    { icon: Tv, label: '剧集', href: '/douban?type=tv' },
    { icon: Sparkles, label: '动漫', href: '/douban?type=tv&sub=tv_animation' },
    { icon: Clover, label: '综艺', href: '/douban?type=show' },
    {
      icon: Video,
      label: '纪录片',
      href: '/douban?type=tv&sub=tv_documentary',
    },
    { icon: Flame, label: '18+专区', href: '/adult' },
    { icon: Clapperboard, label: 'AI黄果', href: '/huangguo' },
  ]);

  useEffect(() => {
    const runtimeConfig = (window as any).RUNTIME_CONFIG;
    if (runtimeConfig?.CUSTOM_CATEGORIES?.length > 0) {
      setNavItems((prevItems) => [
        ...prevItems,
        {
          icon: Star,
          label: '自定义',
          href: '/douban?type=custom',
        },
      ]);
    }
  }, []);

  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector(
      '[data-active="true"]'
    ) as HTMLElement | null;
    if (!item) return;
    const left = item.offsetLeft;
    const right = left + item.offsetWidth;
    if (left < list.scrollLeft) {
      list.scrollTo({ left: Math.max(0, left - 8) });
    } else if (right > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: right - list.clientWidth + 8 });
    }
  }, [currentActive, navItems]);

  const isActive = (href: string) => {
    const typeMatch = href.match(/type=([^&]+)/)?.[1];
    const subMatch = href.match(/sub=([^&]+)/)?.[1];

    // 解码URL以进行正确的比较
    const decodedActive = decodeURIComponent(currentActive);
    const decodedItemHref = decodeURIComponent(href);
    const srcMatch = decodedActive.match(/(?:^|[?&])src=([^&]+)/)?.[1];

    // 精确匹配
    if (decodedActive === decodedItemHref) return true;
    if (href === '/adult' && decodedActive.startsWith('/adult')) return true;
    if (href === '/huangguo' && decodedActive.startsWith('/huangguo')) {
      return true;
    }
    if (srcMatch === 'bangumi' || srcMatch === 'bilibili') {
      return decodedItemHref.includes(`src=${srcMatch}`);
    }

    if (decodedActive.startsWith('/douban') && typeMatch) {
      const activeHasSub = decodedActive.includes('sub=');
      const itemHasSub = !!subMatch;

      if (itemHasSub) {
        // 菜单项有sub参数，必须精确匹配
        return (
          decodedActive.includes(`type=${typeMatch}`) &&
          decodedActive.includes(`sub=${subMatch}`)
        );
      } else {
        // 菜单项没有sub参数，只有当前URL也没有sub时才匹配
        return decodedActive.includes(`type=${typeMatch}`) && !activeHasSub;
      }
    }

    return false;
  };

  return (
    <nav
      className='md:hidden fixed left-0 right-0 z-[600] bg-white/90 backdrop-blur-xl border-t border-gray-200/50 overflow-hidden dark:bg-gray-900/80 dark:border-gray-700/50'
      style={{
        /* 紧贴视口底部，同时在内部留出安全区高度 */
        bottom: 0,
        paddingBottom: 'env(safe-area-inset-bottom)',
        minHeight: 'calc(3.5rem + env(safe-area-inset-bottom))',
      }}
    >
      <div className='relative'>
        <ul
          ref={listRef}
          className='flex items-center overflow-x-auto scrollbar-hide'
        >
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <li
                key={item.href}
                data-active={active ? 'true' : 'false'}
                className='min-w-[4.25rem] flex-shrink-0'
              >
                <Link
                  href={item.href}
                  className='flex h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px]'
                >
                  <item.icon
                    className={`h-5 w-5 ${
                      active
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-500 dark:text-gray-400'
                    }`}
                  />
                  <span
                    className={
                      active
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-gray-600 dark:text-gray-300'
                    }
                  >
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div
          aria-hidden
          className='pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-white to-transparent dark:from-gray-900'
        />
      </div>
    </nav>
  );
};

export default MobileBottomNav;
