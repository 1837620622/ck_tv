'use client';

import Link from 'next/link';

import { BackButton } from './BackButton';
import BrandMark from './BrandMark';
import { useSite } from './SiteProvider';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

interface MobileHeaderProps {
  showBackButton?: boolean;
}

const MobileHeader = ({ showBackButton = false }: MobileHeaderProps) => {
  const { siteName } = useSite();
  return (
    // 顶部留出安全区：iPhone 刘海屏、手机客户端和添加到主屏幕后，页面会延伸到状态栏下面（viewport-fit=cover）。
    // 普通浏览器里这个值是 0，没有影响。
    <header
      className='w-full border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950 md:hidden'
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className='relative h-12 flex items-center justify-between px-4'>
        {/* 左侧：返回按钮和设置按钮 */}
        <div className='flex items-center gap-2'>
          {showBackButton && <BackButton />}
        </div>

        {/* 右侧按钮 */}
        <div className='flex items-center gap-2'>
          <ThemeToggle />
          <UserMenu />
        </div>

        {/* 中间：Logo（在这一行里绝对居中，不受顶部安全区影响） */}
        <div className='absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2'>
          <Link
            href='/'
            className='flex max-w-[58vw] items-center gap-2 text-lg font-bold tracking-tight text-gray-900 transition-opacity hover:opacity-80 dark:text-white'
          >
            <BrandMark size={26} />
            <span className='truncate'>{siteName}</span>
          </Link>
        </div>
      </div>
    </header>
  );
};

export default MobileHeader;
