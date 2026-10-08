'use client';

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
    <nav
      aria-label='翻页'
      className='mt-6 flex items-center justify-center gap-3 text-sm text-gray-700 dark:text-gray-200'
    >
      <button
        type='button'
        disabled={page <= 1}
        onClick={onPrev}
        className='border border-gray-300 px-3 py-2 disabled:opacity-40 dark:border-gray-600'
      >
        上一页
      </button>
      <form
        className='flex items-center gap-2'
        onSubmit={(event) => {
          event.preventDefault();
          onJump(asPage(draft, page));
        }}
      >
        <input
          inputMode='numeric'
          aria-label='页码'
          value={draft}
          onChange={(event) =>
            setDraft(event.target.value.replace(/[^\d]/g, ''))
          }
          className='h-10 w-14 border border-gray-300 bg-white text-center text-gray-900 outline-none focus:border-green-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100'
        />
        <span>/ {pageCount}</span>
      </form>
      <button
        type='button'
        disabled={page >= pageCount}
        onClick={onNext}
        className='border border-gray-300 px-3 py-2 disabled:opacity-40 dark:border-gray-600'
      >
        下一页
      </button>
    </nav>
  );
}
