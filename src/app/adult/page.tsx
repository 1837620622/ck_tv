/* eslint-disable no-console */

'use client';

import { Flame, Search, X } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';

import { SearchResult } from '@/lib/types';
import { isUnderageLabel } from '@/lib/yellow';

import AgeGate, { AgeNotice, readAgeGate } from '@/components/AgeGate';
import PageLayout from '@/components/PageLayout';
import PagePager from '@/components/PagePager';
import VideoCard from '@/components/VideoCard';

interface SourceOption {
  key: string;
  name: string;
}

interface CategoryOption {
  type_id: number | string;
  type_name: string;
}

function asPage(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function scrollPageTop() {
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
}

function keepAdultItem(item: SearchResult): boolean {
  return (
    !isUnderageLabel(item.title) &&
    !isUnderageLabel(item.type_name) &&
    !isUnderageLabel(item.class)
  );
}

function AdultPageClient() {
  const [ready, setReady] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [activeSource, setActiveSource] = useState('zy91md');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [activeCategory, setActiveCategory] = useState('');
  const [videos, setVideos] = useState<SearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [draftQuery, setDraftQuery] = useState('');
  const [committedQuery, setCommittedQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const requestId = useRef(0);
  const categoryCache = useRef<Record<string, CategoryOption[]>>({});

  useEffect(() => {
    setUnlocked(readAgeGate());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    scrollPageTop();
  }, [unlocked, page, activeSource, activeCategory, committedQuery]);

  useEffect(() => {
    if (!unlocked) return;
    const req = ++requestId.current;
    const controller = new AbortController();
    const pageNum = asPage(page, 1);
    const sourceKey = activeSource;
    setLoading(true);

    const applyCategories = (list: CategoryOption[]) => {
      const next = list.filter((item) => !isUnderageLabel(item.type_name));
      categoryCache.current[sourceKey] = next;
      if (req === requestId.current) setCategories(next);
    };

    const run = async () => {
      const url = isSearching
        ? `/api/adult?action=search&q=${encodeURIComponent(
            committedQuery
          )}&page=${pageNum}`
        : `/api/adult?action=list&source=${encodeURIComponent(
            sourceKey
          )}&page=${pageNum}${
            activeCategory ? `&t=${encodeURIComponent(activeCategory)}` : ''
          }`;
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        if (req !== requestId.current) return;
        const list = ((data.list || []) as SearchResult[]).filter(
          keepAdultItem
        );
        setVideos(list);
        const incoming = Number(data.pagecount);
        const hasCount = Number.isFinite(incoming) && incoming >= 1;
        if (list.length > 0 && hasCount) {
          setPageCount(Math.floor(incoming));
        } else if (hasCount && incoming > 1) {
          setPageCount(Math.floor(incoming));
        } else if (pageNum === 1 && list.length === 0) {
          setPageCount(1);
        }
        if (Array.isArray(data.sources) && data.sources.length > 0) {
          setSources(data.sources);
        }
        if (!isSearching) {
          const cached = categoryCache.current[sourceKey];
          if (cached) {
            setCategories(cached);
          } else if (
            Array.isArray(data.categories) &&
            data.categories.length > 0
          ) {
            applyCategories(data.categories);
          } else {
            const typesRes = await fetch(
              `/api/adult?action=types&source=${encodeURIComponent(sourceKey)}`,
              { cache: 'no-store', signal: controller.signal }
            );
            const typesData = await typesRes.json();
            if (req !== requestId.current) return;
            applyCategories(typesData.categories || []);
          }
        }
      } catch (err) {
        if (controller.signal.aborted || req !== requestId.current) return;
        console.error('获取成人内容失败:', err);
        if (pageNum === 1) setVideos([]);
      } finally {
        if (req === requestId.current) setLoading(false);
      }
    };

    run();
    return () => controller.abort();
  }, [
    unlocked,
    activeSource,
    activeCategory,
    page,
    isSearching,
    committedQuery,
  ]);

  const goPage = (next: number) => {
    const target = Math.min(
      Math.max(1, asPage(next, 1)),
      Math.max(1, pageCount)
    );
    setPage(target);
  };

  const handleSearch = (event: React.FormEvent) => {
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
  };

  const handleClearSearch = () => {
    setDraftQuery('');
    setCommittedQuery('');
    setIsSearching(false);
    setPage(1);
  };

  const handleSourceChange = (key: string) => {
    setActiveSource(key);
    setActiveCategory('');
    setCategories(categoryCache.current[key] || []);
    setDraftQuery('');
    setCommittedQuery('');
    setIsSearching(false);
    setPage(1);
  };

  const handleCategoryChange = (typeId: string) => {
    setActiveCategory(typeId);
    setDraftQuery('');
    setCommittedQuery('');
    setIsSearching(false);
    setPage(1);
  };

  return (
    <PageLayout activePath='/adult'>
      {!ready ? <div className='min-h-screen' /> : null}
      {ready && !unlocked ? (
        <AgeGate title='18+ 专区' onUnlock={() => setUnlocked(true)} />
      ) : null}
      {ready && unlocked ? (
        <div className='min-h-screen max-w-full overflow-x-hidden px-3 py-4 pb-8 sm:px-10 sm:py-8'>
          <div className='mb-5 flex flex-col gap-4 border-b border-gray-200 pb-4 dark:border-gray-800 sm:flex-row sm:items-center sm:justify-between'>
            <div className='flex items-center gap-3'>
              <Flame className='h-5 w-5 text-green-600' />
              <div>
                <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
                  18+ 专区
                </h1>
                <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
                  只在本栏目浏览和搜索，不会出现在全站搜索里
                </p>
                <AgeNotice />
              </div>
            </div>
            <form onSubmit={handleSearch} className='w-full sm:w-80'>
              <div className='relative'>
                <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400' />
                <input
                  type='text'
                  value={draftQuery}
                  onChange={(event) => setDraftQuery(event.target.value)}
                  placeholder='搜片名、演员'
                  className='h-10 w-full border border-gray-200 bg-gray-50 py-2 pl-9 pr-9 text-sm text-gray-800 outline-none focus:border-green-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100'
                />
                {draftQuery ? (
                  <button
                    type='button'
                    onClick={handleClearSearch}
                    aria-label='清空搜索'
                    className='absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400'
                  >
                    <X className='h-4 w-4' />
                  </button>
                ) : null}
              </div>
            </form>
          </div>

          {sources.length > 0 && !isSearching ? (
            <div className='mb-3 flex items-center gap-2 overflow-x-auto pb-1'>
              <span className='shrink-0 text-xs text-gray-400'>源站</span>
              {sources.map((src) => {
                const active = activeSource === src.key;
                return (
                  <button
                    key={src.key}
                    type='button'
                    onClick={() => handleSourceChange(src.key)}
                    className={`shrink-0 px-3 py-1.5 text-xs ${
                      active
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'
                    }`}
                  >
                    {src.name}
                  </button>
                );
              })}
            </div>
          ) : null}

          {categories.length > 0 && !isSearching ? (
            <div className='mb-5 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto'>
              <button
                type='button'
                onClick={() => handleCategoryChange('')}
                className={`px-3 py-1 text-xs ${
                  activeCategory === ''
                    ? 'bg-green-600 text-white'
                    : 'text-gray-600 dark:text-gray-300'
                }`}
              >
                全部
              </button>
              {categories.map((cat) => {
                const catId = cat.type_id.toString();
                const active = activeCategory === catId;
                return (
                  <button
                    key={catId}
                    type='button'
                    onClick={() => handleCategoryChange(catId)}
                    className={`px-3 py-1 text-xs ${
                      active
                        ? 'bg-green-600 text-white'
                        : 'text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {cat.type_name}
                  </button>
                );
              })}
            </div>
          ) : null}

          {isSearching ? (
            <div className='mb-4 flex items-center justify-between text-xs text-gray-500'>
              <span>
                搜索「{committedQuery}」
                {loading ? '，加载中' : `，本页 ${videos.length} 条`}
              </span>
              <button
                type='button'
                onClick={handleClearSearch}
                className='text-green-600'
              >
                返回浏览
              </button>
            </div>
          ) : null}

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
                  key={`${item.source}-${item.id}`}
                  id={item.id}
                  title={item.title}
                  poster={item.poster}
                  episodes={item.episodes?.length || 1}
                  source={item.source}
                  source_name={item.source_name}
                  douban_id={item.douban_id?.toString()}
                  year={item.year}
                  from='adult'
                  type='movie'
                />
              ))}
            </div>
          ) : null}

          {!loading && videos.length === 0 ? (
            <div className='py-20 text-center text-sm text-gray-400'>
              这一页没有内容，换个源站或回到上一页
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
                Math.min(Math.max(1, pageCount), asPage(current, 1) + 1)
              )
            }
            onJump={goPage}
          />
        </div>
      ) : null}
    </PageLayout>
  );
}

export default function AdultPage() {
  return (
    <Suspense>
      <AdultPageClient />
    </Suspense>
  );
}
