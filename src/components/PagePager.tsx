'use client';

import { useEffect, useState } from 'react';

function asPage(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// totalKnown 为 false 时上游没给真实总页数，只显示「第 N 页」，不能拿推测的总数当分母。
// hasNext 不传时按 page < pageCount 判断。
export default function PagePager({
  page,
  pageCount,
  hasNext,
  totalKnown = true,
  busy = false,
  onPrev,
  onNext,
  onJump,
}: {
  page: number;
  pageCount: number;
  hasNext?: boolean;
  totalKnown?: boolean;
  // 请求还没返回时禁止翻页，否则连点会跳过一页（前一次的请求会被取消）
  busy?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onJump: (page: number) => void;
}) {
  const [draft, setDraft] = useState(String(page));

  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  const nextEnabled = hasNext ?? page < pageCount;
  if (!nextEnabled && page <= 1) return null;

  return (
    <nav
      aria-label='翻页'
      className='mt-6 flex items-center justify-center gap-3 text-sm text-gray-700 dark:text-gray-200'
    >
      <button
        type='button'
        disabled={busy || page <= 1}
        onClick={onPrev}
        className='h-11 border border-gray-300 px-4 disabled:opacity-40 dark:border-gray-600'
      >
        上一页
      </button>
      {totalKnown ? (
        <form
          className='flex items-center gap-2'
          onSubmit={(event) => {
            event.preventDefault();
            onJump(asPage(draft, page));
          }}
        >
          {/* iPhone 的数字键盘没有回车键，失去焦点时也提交（见 onBlur），否则输入的页码会被丢掉 */}
          <input
            inputMode='numeric'
            aria-label='页码'
            disabled={busy}
            value={draft}
            onChange={(event) =>
              setDraft(event.target.value.replace(/[^\d]/g, ''))
            }
            onBlur={() => {
              if (draft !== String(page)) onJump(asPage(draft, page));
            }}
            className='h-11 w-16 border border-gray-300 bg-white text-center text-gray-900 outline-none focus:border-green-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100'
          />
          <span>/ {pageCount}</span>
        </form>
      ) : (
        <span className='min-w-[4.5rem] text-center'>第 {page} 页</span>
      )}
      <button
        type='button'
        disabled={busy || !nextEnabled}
        onClick={onNext}
        className='h-11 border border-gray-300 px-4 disabled:opacity-40 dark:border-gray-600'
      >
        下一页
      </button>
    </nav>
  );
}
