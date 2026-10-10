/* eslint-disable react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any */
'use client';

import { ChevronUp, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import {
  addSearchHistory,
  clearSearchHistory,
  deleteSearchHistory,
  getSearchHistory,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import {
  compactTitle,
  repairTitle,
  titleParts,
  titleRank,
  workKey,
} from '@/lib/match-title';
import { SearchResult } from '@/lib/types';
import { isAdultContent } from '@/lib/yellow';

import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

function SearchPageClient() {
  // 搜索历史
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  // 返回顶部按钮显示状态
  const [showBackToTop, setShowBackToTop] = useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  // 获取默认聚合设置：只读取用户本地设置，默认为 true
  const getDefaultAggregate = () => {
    if (typeof window !== 'undefined') {
      const userSetting = localStorage.getItem('defaultAggregateSearch');
      if (userSetting !== null) {
        return JSON.parse(userSetting);
      }
    }
    return true; // 默认启用聚合
  };

  const [viewMode, setViewMode] = useState<'agg' | 'all'>(() => {
    return getDefaultAggregate() ? 'agg' : 'all';
  });

  // 聚合后的结果（按标题和年份分组）
  const aggregatedResults = useMemo(() => {
    const map = new Map<string, SearchResult[]>();
    searchResults.forEach((item) => {
      const episodes = item.episode_count ?? item.episodes?.length ?? 0;
      const key = workKey(item.title, item.year, episodes);
      const arr = map.get(key) || [];
      arr.push(item);
      map.set(key, arr);
    });
    // 同一部只有一个明确年份时，把缺年份的并进去，避免预告拆成多张卡。
    const grouped = new Map<string, SearchResult[]>();
    const byIdentity = new Map<string, string[]>();
    map.forEach((items, key) => {
      const identity = key.slice(0, key.lastIndexOf('|'));
      const list = byIdentity.get(identity) || [];
      list.push(key);
      byIdentity.set(identity, list);
    });
    byIdentity.forEach((keys) => {
      const dated = keys.filter((key) => key.slice(key.lastIndexOf('|') + 1));
      const undated = keys.filter(
        (key) => !key.slice(key.lastIndexOf('|') + 1)
      );
      if (dated.length === 1 && undated.length > 0) {
        const merged = dated
          .concat(undated)
          .flatMap((key) => map.get(key) || []);
        grouped.set(dated[0], merged);
        return;
      }
      keys.forEach((key) => {
        const items = map.get(key);
        if (items) grouped.set(key, items);
      });
    });
    // 同一年份、修好后片名相同的电影和剧集写法并成一张卡。
    const byLabel = new Map<string, SearchResult[]>();
    grouped.forEach((items) => {
      const title = repairTitle(items[0]?.title || '');
      const year =
        items.find((item) => /^\d{4}$/.test(item.year || ''))?.year || '';
      const label = `${compactTitle(title)}|${year}`;
      const bucket = byLabel.get(label) || [];
      bucket.push(...items);
      byLabel.set(label, bucket);
    });
    byLabel.forEach((items, key) => {
      items.sort(
        (a, b) =>
          titleRank(a.title, searchQuery) - titleRank(b.title, searchQuery)
      );
      byLabel.set(key, items);
    });
    return Array.from(byLabel.entries()).sort((a, b) => {
      // 优先排序：标题与搜索词完全一致的排在前面
      const wanted = searchQuery.trim();
      const rankSide = (title: string) => {
        const part = titleParts(title);
        if (
          part.base &&
          part.base === titleParts(wanted).base &&
          !part.trailer
        ) {
          return 0;
        }
        if (part.base && part.base === titleParts(wanted).base) return 1;
        return 2;
      };
      const aExactMatch = rankSide(a[1][0].title);
      const bExactMatch = rankSide(b[1][0].title);

      if (aExactMatch !== bExactMatch) return aExactMatch - bExactMatch;

      // 年份排序
      if (a[1][0].year === b[1][0].year) {
        return a[0].localeCompare(b[0]);
      } else {
        // 处理 unknown 的情况
        const aYear = a[1][0].year;
        const bYear = b[1][0].year;

        if (aYear === 'unknown' && bYear === 'unknown') {
          return 0;
        } else if (aYear === 'unknown') {
          return 1; // a 排在后面
        } else if (bYear === 'unknown') {
          return -1; // b 排在后面
        } else {
          // 都是数字年份，按数字大小排序（大的在前面）
          return aYear > bYear ? -1 : 1;
        }
      }
    });
  }, [searchResults, searchQuery]);

  useEffect(() => {
    // 无搜索参数时聚焦搜索框
    !searchParams.get('q') && document.getElementById('searchInput')?.focus();

    // 初始加载搜索历史
    getSearchHistory().then(setSearchHistory);

    // 监听搜索历史更新事件
    const unsubscribe = subscribeToDataUpdates(
      'searchHistoryUpdated',
      (newHistory: string[]) => {
        setSearchHistory(newHistory);
      }
    );

    // 获取滚动位置的函数 - 专门针对 body 滚动
    const getScrollTop = () => {
      return document.body.scrollTop || 0;
    };

    // 使用 requestAnimationFrame 持续检测滚动位置
    let isRunning = false;
    const checkScrollPosition = () => {
      if (!isRunning) return;

      const scrollTop = getScrollTop();
      const shouldShow = scrollTop > 300;
      setShowBackToTop(shouldShow);

      requestAnimationFrame(checkScrollPosition);
    };

    // 启动持续检测
    isRunning = true;
    checkScrollPosition();

    // 监听 body 元素的滚动事件
    const handleScroll = () => {
      const scrollTop = getScrollTop();
      setShowBackToTop(scrollTop > 300);
    };

    document.body.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      unsubscribe();
      isRunning = false; // 停止 requestAnimationFrame 循环

      // 移除 body 滚动事件监听器
      document.body.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    // 当搜索参数变化时更新搜索状态
    const query = searchParams.get('q');
    if (query) {
      setSearchQuery(query);
      fetchSearchResults(query);

      // 保存到搜索历史 (事件监听会自动更新界面)
      addSearchHistory(query);
    } else {
      setShowResults(false);
    }
  }, [searchParams]);

  const searchSeq = useRef(0);

  const sortResults = (results: SearchResult[], query: string) =>
    results.sort((a: SearchResult, b: SearchResult) => {
      const keyword = query.trim();
      const aExactMatch = a.title === keyword;
      const bExactMatch = b.title === keyword;

      if (aExactMatch && !bExactMatch) return -1;
      if (!aExactMatch && bExactMatch) return 1;

      if (a.year === b.year) {
        return a.title.localeCompare(b.title);
      }
      if (a.year === 'unknown' && b.year === 'unknown') {
        return 0;
      }
      if (a.year === 'unknown') return 1;
      if (b.year === 'unknown') return -1;
      return parseInt(a.year) > parseInt(b.year) ? -1 : 1;
    });

  const fetchSearchResults = async (query: string) => {
    const seq = ++searchSeq.current;
    const searchUrl = `/api/search?q=${encodeURIComponent(
      query.trim()
    )}&slim=1&v=11`;
    try {
      setIsLoading(true);
      const response = await fetch(searchUrl, { cache: 'no-store' });
      const data = await response.json();
      if (seq !== searchSeq.current) return;
      const results = (data.results || [])
        .filter((result: SearchResult) => !isAdultContent(result))
        .map((result: SearchResult) => ({
          ...result,
          title: repairTitle(result.title),
        }));
      setSearchResults(sortResults(results, query));
      setShowResults(true);
      // 首包只有排序靠前的片源。等边缘把其余源写入缓存后再拉一次完整结果。
      if (response.headers.get('x-ck-cache') === 'PARTIAL') {
        window.setTimeout(async () => {
          if (seq !== searchSeq.current) return;
          try {
            const again = await fetch(searchUrl, { cache: 'no-store' });
            const againData = await again.json();
            if (seq !== searchSeq.current) return;
            const more = (againData.results || [])
              .filter((result: SearchResult) => !isAdultContent(result))
              .map((result: SearchResult) => ({
                ...result,
                title: repairTitle(result.title),
              }));
            if (more.length > results.length) {
              setSearchResults(sortResults(more, query));
            }
            if (again.headers.get('x-ck-cache') === 'PARTIAL') {
              window.setTimeout(async () => {
                if (seq !== searchSeq.current) return;
                try {
                  const third = await fetch(searchUrl, { cache: 'no-store' });
                  const thirdData = await third.json();
                  if (seq !== searchSeq.current) return;
                  const full = (thirdData.results || [])
                    .filter((result: SearchResult) => !isAdultContent(result))
                    .map((result: SearchResult) => ({
                      ...result,
                      title: repairTitle(result.title),
                    }));
                  if (full.length > more.length) {
                    setSearchResults(sortResults(full, query));
                  }
                } catch {
                  // 第二次补全失败时保留当前结果
                }
              }, 2000);
            }
          } catch {
            // 补全失败时保留已经显示的首批结果
          }
        }, 1800);
      }
    } catch (error) {
      if (seq === searchSeq.current) setSearchResults([]);
    } finally {
      if (seq === searchSeq.current) setIsLoading(false);
    }
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim().replace(/\s+/g, ' ');
    if (!trimmed) return;

    // 回显搜索框
    setSearchQuery(trimmed);
    setIsLoading(true);
    setShowResults(true);

    router.push(`/search?q=${encodeURIComponent(trimmed)}`);
    // 直接发请求
    fetchSearchResults(trimmed);

    // 保存到搜索历史 (事件监听会自动更新界面)
    addSearchHistory(trimmed);
  };

  // 返回顶部功能
  const scrollToTop = () => {
    try {
      // 根据调试结果，真正的滚动容器是 document.body
      document.body.scrollTo({
        top: 0,
        behavior: 'smooth',
      });
    } catch (error) {
      // 如果平滑滚动完全失败，使用立即滚动
      document.body.scrollTop = 0;
    }
  };

  return (
    <PageLayout activePath='/search'>
      <div className='px-4 sm:px-10 py-4 sm:py-8 overflow-visible mb-10'>
        {/* 搜索框 */}
        <div className='mb-8'>
          <form onSubmit={handleSearch} className='max-w-2xl mx-auto'>
            <div className='relative'>
              <Search className='absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
              <input
                id='searchInput'
                type='text'
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder='搜索电影、电视剧...'
                className='w-full h-12 rounded-lg bg-gray-50/80 py-3 pl-10 pr-4 text-sm text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-400 focus:bg-white border border-gray-200/50 shadow-sm dark:bg-gray-800 dark:text-gray-300 dark:placeholder-gray-500 dark:focus:bg-gray-700 dark:border-gray-700'
              />
            </div>
          </form>
        </div>

        {/* 搜索结果或搜索历史 */}
        <div className='max-w-[95%] mx-auto mt-12 overflow-visible'>
          {isLoading ? (
            <div className='flex justify-center items-center h-40'>
              <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-green-500'></div>
            </div>
          ) : showResults ? (
            <section className='mb-12'>
              {/* 标题 + 聚合开关 */}
              <div className='mb-8 flex items-center justify-between'>
                <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                  搜索结果
                </h2>
                {/* 聚合开关 */}
                <label className='flex items-center gap-2 cursor-pointer select-none'>
                  <span className='text-sm text-gray-700 dark:text-gray-300'>
                    聚合
                  </span>
                  <div className='relative'>
                    <input
                      type='checkbox'
                      className='sr-only peer'
                      checked={viewMode === 'agg'}
                      onChange={() =>
                        setViewMode(viewMode === 'agg' ? 'all' : 'agg')
                      }
                    />
                    <div className='w-9 h-5 bg-gray-300 rounded-full peer-checked:bg-green-500 transition-colors dark:bg-gray-600'></div>
                    <div className='absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4'></div>
                  </div>
                </label>
              </div>
              <div
                key={`search-results-${viewMode}`}
                className='justify-start grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'
              >
                {viewMode === 'agg'
                  ? aggregatedResults.map(([mapKey, group]) => {
                      return (
                        <div key={`agg-${mapKey}`} className='w-full'>
                          <VideoCard
                            from='search'
                            items={group}
                            query={
                              searchQuery.trim() !== group[0].title
                                ? searchQuery.trim()
                                : ''
                            }
                          />
                        </div>
                      );
                    })
                  : searchResults.map((item) => (
                      <div
                        key={`all-${item.source}-${item.id}`}
                        className='w-full'
                      >
                        <VideoCard
                          id={item.id}
                          title={item.title}
                          poster={item.poster}
                          episodes={item.episode_count ?? item.episodes.length}
                          source={item.source}
                          source_name={item.source_name}
                          douban_id={item.douban_id?.toString()}
                          query={
                            searchQuery.trim() !== item.title
                              ? searchQuery.trim()
                              : ''
                          }
                          year={item.year}
                          from='search'
                          type={
                            (item.episode_count ?? item.episodes.length) > 1
                              ? 'tv'
                              : ''
                          }
                        />
                      </div>
                    ))}
                {searchResults.length === 0 && (
                  <div className='col-span-full text-center text-gray-500 py-8 dark:text-gray-400'>
                    未找到相关结果
                  </div>
                )}
              </div>
            </section>
          ) : searchHistory.length > 0 ? (
            // 搜索历史
            <section className='mb-12'>
              <h2 className='mb-4 text-xl font-bold text-gray-800 text-left dark:text-gray-200'>
                搜索历史
                {searchHistory.length > 0 && (
                  <button
                    onClick={() => {
                      clearSearchHistory(); // 事件监听会自动更新界面
                    }}
                    className='ml-3 text-sm text-gray-500 hover:text-red-500 transition-colors dark:text-gray-400 dark:hover:text-red-500'
                  >
                    清空
                  </button>
                )}
              </h2>
              <div className='flex flex-wrap gap-1.5'>
                {searchHistory.map((item) => (
                  <div
                    key={item}
                    className='flex items-stretch border border-gray-300 dark:border-gray-600'
                  >
                    <button
                      type='button'
                      onClick={() => {
                        setSearchQuery(item);
                        router.push(
                          `/search?q=${encodeURIComponent(item.trim())}`
                        );
                      }}
                      className='px-3 py-1.5 text-sm text-gray-700 hover:text-green-700 dark:text-gray-200'
                    >
                      {item}
                    </button>
                    <button
                      type='button'
                      aria-label='删除搜索历史'
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        deleteSearchHistory(item);
                      }}
                      className='border-l border-gray-300 px-2 text-xs text-gray-500 hover:text-red-600 dark:border-gray-600'
                    >
                      删除
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {/* 返回顶部悬浮按钮 */}
      <button
        onClick={scrollToTop}
        className={`fixed bottom-20 right-4 z-[500] flex h-10 w-10 items-center justify-center bg-green-600 text-white md:bottom-6 ${
          showBackToTop
            ? 'pointer-events-auto opacity-100'
            : 'pointer-events-none opacity-0'
        }`}
        aria-label='返回顶部'
      >
        <ChevronUp className='h-5 w-5' />
      </button>
    </PageLayout>
  );
}

export default function SearchPage() {
  return (
    <Suspense>
      <SearchPageClient />
    </Suspense>
  );
}
