/* eslint-disable no-console */

'use client';

import { Clapperboard, Search, X } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';

import { HUANGGUO_CATEGORIES } from '@/lib/huangguo';
import { isUnderageLabel } from '@/lib/yellow';

import AgeGate, { AgeNotice, readAgeGate } from '@/components/AgeGate';
import PageLayout from '@/components/PageLayout';
import PagePager from '@/components/PagePager';
import VideoCard from '@/components/VideoCard';

interface CardItem {
  id: string;
  title: string;
  poster: string;
  episode_count?: number;
  source: string;
  source_name: string;
  year?: string;
}

function asPage(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function scrollPageTop() {
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
}

function HuangguoClient() {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [category, setCategory] = useState('hot');
  const [videos, setVideos] = useState<CardItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [draftQuery, setDraftQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const requestId = useRef(0);
  const pageCountRef = useRef(1);

  useEffect(() => {
    setUnlocked(readAgeGate());
    setReady(true);
  }, []);

  useEffect(() => {
    pageCountRef.current = pageCount;
  }, [pageCount]);

  useEffect(() => {
    if (!unlocked) return;
    scrollPageTop();
  }, [unlocked, page, category, committedQuery]);

  useEffect(() => {
    if (!unlocked) return;
    const req = ++requestId.current;
    const controller = new AbortController();
    const pageNum = asPage(page, 1);
    setLoading(true);
    const url = isSearching
      ? `/api/huangguo?action=search&q=${encodeURIComponent(
          committedQuery
        )}&page=${pageNum}`
      : `/api/huangguo?action=list&t=${encodeURIComponent(
          category
        )}&page=${pageNum}`;

    const run = async () => {
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        const data = await response.json();
        if (req !== requestId.current) return;
        const list = ((data.list || []) as CardItem[]).filter(
          (item) => !isUnderageLabel(item.title)
        );
        setVideos(list);
        const incoming = Number(data.pagecount);
        if (
          Number.isFinite(incoming) &&
          incoming >= 1 &&
          (list.length > 0 || incoming > 1)
        ) {
          setPageCount(Math.floor(incoming));
        } else if (pageNum === 1 && list.length === 0) {
          setPageCount(1);
        }
      } catch (error) {
        if (controller.signal.aborted || req !== requestId.current) return;
        console.error('黄果列表失败:', error);
        if (pageNum === 1) setVideos([]);
      } finally {
        if (req === requestId.current) setLoading(false);
      }
    };
    run();
    return () => controller.abort();
  }, [unlocked, category, page, isSearching, committedQuery]);

  const jump = (next: number) => {
    setPage((current) =>
      Math.min(
        Math.max(1, asPage(next, current)),
        Math.max(1, pageCountRef.current)
      )
    );
  };

  return (
    <PageLayout activePath='/huangguo'>
      {!ready ? <div className='min-h-screen' /> : null}
      {ready && !unlocked ? (
        <AgeGate title='AI黄果' onUnlock={() => setUnlocked(true)} />
      ) : null}
      {ready && unlocked ? (
        <div className='min-h-screen max-w-full overflow-x-hidden px-3 py-4 pb-8 sm:px-10 sm:py-8'>
          <div className='mb-5 flex flex-col gap-4 border-b border-gray-200 pb-4 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between'>
            <div className='flex items-center gap-3'>
              <Clapperboard className='h-5 w-5 text-green-600' />
              <div>
                <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
                  AI黄果
                </h1>
                <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
                  AI 短剧单独成栏，不进全站搜索
                </p>
                <AgeNotice />
              </div>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const query = draftQuery.trim();
                if (!query) {
                  setIsSearching(false);
                  setCommittedQuery('');
                  setPage(1);
                  return;
                }
                setCommittedQuery(query);
                setIsSearching(true);
                setPage(1);
              }}
              className='w-full sm:w-80'
            >
              <div className='relative'>
                <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400' />
                <input
                  value={draftQuery}
                  onChange={(event) => setDraftQuery(event.target.value)}
                  placeholder='搜黄果剧名'
                  className='h-10 w-full border border-gray-200 bg-gray-50 py-2 pl-9 pr-9 text-sm text-gray-800 outline-none focus:border-green-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
                />
                {draftQuery ? (
                  <button
                    type='button'
                    aria-label='清空搜索'
                    onClick={() => {
                      setDraftQuery('');
                      setCommittedQuery('');
                      setIsSearching(false);
                      setPage(1);
                    }}
                    className='absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400'
                  >
                    <X className='h-4 w-4' />
                  </button>
                ) : null}
              </div>
            </form>
          </div>

          {!isSearching ? (
            <div className='mb-4 flex gap-2 overflow-x-auto pb-1'>
              {HUANGGUO_CATEGORIES.map((item) => (
                <button
                  key={item.id}
                  type='button'
                  onClick={() => {
                    setCategory(item.id);
                    setPage(1);
                  }}
                  className={`shrink-0 px-3 py-1.5 text-xs ${
                    category === item.id
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
                  }`}
                >
                  {item.name}
                </button>
              ))}
            </div>
          ) : (
            <div className='mb-4 flex items-center justify-between text-xs text-gray-500'>
              <span>搜索「{committedQuery}」</span>
              <button
                type='button'
                className='text-green-600'
                onClick={() => {
                  setDraftQuery('');
                  setCommittedQuery('');
                  setIsSearching(false);
                  setPage(1);
                }}
              >
                返回浏览
              </button>
            </div>
          )}

          {loading && videos.length === 0 ? (
            <div className='flex h-64 items-center justify-center'>
              <div className='h-8 w-8 animate-spin rounded-full border-b-2 border-green-600' />
            </div>
          ) : null}

          {videos.length > 0 ? (
            <div
              className={`grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 ${
                loading ? 'opacity-60' : ''
              }`}
            >
              {videos.map((item) => (
                <VideoCard
                  key={item.id}
                  id={item.id}
                  title={item.title}
                  poster={item.poster}
                  episodes={item.episode_count || 1}
                  source='huangguo'
                  source_name='黄果'
                  year={item.year}
                  from='huangguo'
                  type='tv'
                />
              ))}
            </div>
          ) : null}

          {!loading && videos.length === 0 ? (
            <div className='py-20 text-center text-sm text-gray-400'>
              这一页没有内容
            </div>
          ) : null}

          <PagePager
            page={page}
            pageCount={pageCount}
            onPrev={() =>
              setPage((current) => Math.max(1, asPage(current, 1) - 1))
            }
            onNext={() =>
              setPage((current) =>
                Math.min(pageCountRef.current, asPage(current, 1) + 1)
              )
            }
            onJump={jump}
          />
        </div>
      ) : null}
    </PageLayout>
  );
}

export default function HuangguoPage() {
  return (
    <Suspense>
      <HuangguoClient />
    </Suspense>
  );
}
