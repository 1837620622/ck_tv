'use client';

import { useEffect, useRef, useState } from 'react';

import { DoubanItem } from '@/lib/types';

import PagePager from '@/components/PagePager';
import VideoCard from '@/components/VideoCard';

const KINDS: Record<string, { id: string; label: string }[]> = {
  bangumi: [
    { id: 'anime', label: '动画' },
    { id: 'real', label: '三次元' },
  ],
  bilibili: [
    { id: 'bangumi', label: '番剧' },
    { id: 'guochuang', label: '国创' },
    { id: 'movie', label: '电影' },
    { id: 'tv', label: '电视剧' },
    { id: 'documentary', label: '纪录片' },
    { id: 'variety', label: '综艺' },
  ],
};

function asPage(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export default function CatalogPanel({
  engine,
}: {
  engine: 'bangumi' | 'bilibili';
}) {
  const kinds = KINDS[engine];
  const [kind, setKind] = useState(kinds[0].id);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [items, setItems] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const pageCountRef = useRef(1);
  const requestId = useRef(0);

  useEffect(() => {
    setKind(KINDS[engine][0].id);
    setPage(1);
  }, [engine]);

  useEffect(() => {
    pageCountRef.current = pageCount;
  }, [pageCount]);

  useEffect(() => {
    const req = ++requestId.current;
    const controller = new AbortController();
    setLoading(true);
    const run = async () => {
      try {
        const response = await fetch(
          `/api/catalog?engine=${engine}&kind=${encodeURIComponent(
            kind
          )}&page=${page}&v=3`,
          { cache: 'no-store', signal: controller.signal }
        );
        const data = await response.json();
        if (req !== requestId.current) return;
        setItems(Array.isArray(data.list) ? data.list : []);
        const count = Number(data.pagecount);
        setPageCount(
          Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1
        );
      } catch {
        if (req === requestId.current) setItems([]);
      } finally {
        if (req === requestId.current) setLoading(false);
      }
    };
    run();
    return () => controller.abort();
  }, [engine, kind, page]);

  return (
    <div className='pb-8'>
      <div className='mb-4 flex gap-2 overflow-x-auto'>
        {kinds.map((item) => (
          <button
            key={item.id}
            type='button'
            onClick={() => {
              setKind(item.id);
              setPage(1);
            }}
            className={`shrink-0 px-3 py-1.5 text-xs ${
              kind === item.id
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {loading && items.length === 0 ? (
        <div className='flex h-64 items-center justify-center'>
          <div className='h-8 w-8 animate-spin rounded-full border-b-2 border-green-600' />
        </div>
      ) : null}
      {items.length > 0 ? (
        <div
          className={`grid grid-cols-3 gap-x-2 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:gap-x-8 ${
            loading ? 'opacity-60' : ''
          }`}
        >
          {items.map((item) => (
            <VideoCard
              key={`${engine}-${item.id}`}
              from='douban'
              title={item.title}
              poster={item.poster}
              douban_id={item.id}
              rate={item.rate}
              year={item.year}
              type={kind === 'movie' ? 'movie' : ''}
            />
          ))}
        </div>
      ) : null}
      {!loading && items.length === 0 ? (
        <div className='py-16 text-center text-sm text-gray-400'>
          这一页没有内容
        </div>
      ) : null}
      <PagePager
        page={page}
        pageCount={pageCount}
        onPrev={() => setPage((current) => Math.max(1, asPage(current, 1) - 1))}
        onNext={() =>
          setPage((current) =>
            Math.min(pageCountRef.current, asPage(current, 1) + 1)
          )
        }
        onJump={(next) =>
          setPage((current) =>
            Math.min(
              Math.max(1, asPage(next, current)),
              Math.max(1, pageCountRef.current)
            )
          )
        }
      />
    </div>
  );
}
