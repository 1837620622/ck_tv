'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';

function asPage(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export default function PagePager({
  page,
  pageCount,
  onPrev,
  onNext,
  onJump,
}: {
  page: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  onJump: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(page));

  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  if (pageCount <= 1 && page <= 1) return null;

  return (
    <div className='fixed inset-x-0 z-40 flex justify-center px-3 bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-6'>
      <div className='flex items-center gap-2 border border-neutral-200 bg-white px-2 py-1.5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950'>
        <button
          type='button'
          aria-label='上一页'
          disabled={page <= 1}
          onClick={onPrev}
          className='flex h-11 w-11 items-center justify-center text-gray-700 disabled:opacity-30 dark:text-gray-200'
        >
          <ChevronLeft className='h-5 w-5' />
        </button>
        <form
          className='flex items-center gap-1 text-xs text-gray-600 dark:text-gray-300'
          onSubmit={(event) => {
            event.preventDefault();
            onJump(asPage(draft, page));
          }}
        >
          <span>第</span>
          <input
            inputMode='numeric'
            aria-label='页码'
            value={draft}
            onChange={(event) =>
              setDraft(event.target.value.replace(/[^\d]/g, ''))
            }
            className='h-10 w-14 border border-neutral-300 bg-white text-center text-sm text-gray-900 outline-none focus:border-green-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-gray-100'
          />
          <span>/ {pageCount} 页</span>
        </form>
        <button
          type='button'
          aria-label='下一页'
          disabled={page >= pageCount}
          onClick={onNext}
          className='flex h-11 w-11 items-center justify-center text-gray-700 disabled:opacity-30 dark:text-gray-200'
        >
          <ChevronRight className='h-5 w-5' />
        </button>
      </div>
    </div>
  );
}
