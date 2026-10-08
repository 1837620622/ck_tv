/* eslint-disable no-console, react-hooks/exhaustive-deps, @typescript-eslint/no-explicit-any */

'use client';

import {
  ChevronLeft,
  ChevronRight,
  Flame,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { SearchResult } from '@/lib/types';

import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

interface SourceOption {
  key: string;
  name: string;
}

interface CategoryOption {
  type_id: number | string;
  type_name: string;
}

function AdultPageClient() {
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [activeSource, setActiveSource] = useState<string>('zy91md');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [videos, setVideos] = useState<SearchResult[]>([]);
  const [page, setPage] = useState<number>(1);
  const [pageCount, setPageCount] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);

  // 加载数据
  const loadData = useCallback(
    async (sourceKey: string, categoryId: string, pageNum: number) => {
      setLoading(true);
      setIsSearching(false);
      try {
        const tParam = categoryId ? `&t=${encodeURIComponent(categoryId)}` : '';
        const res = await fetch(
          `/api/adult?action=list&source=${sourceKey}&page=${pageNum}${tParam}`
        );
        if (!res.ok) throw new Error('加载失败');
        const data = await res.json();
        setVideos(data.list || []);
        setPage(data.page || pageNum);
        setPageCount(data.pagecount || 1);

        if (data.sources && data.sources.length > 0) {
          setSources(data.sources);
        }

        // 加载分类
        if (data.categories && data.categories.length > 0) {
          setCategories(data.categories);
        } else {
          // 异步获取该源分类
          fetch(`/api/adult?action=types&source=${sourceKey}`)
            .then((r) => r.json())
            .then((typesData) => {
              if (typesData.categories) {
                setCategories(typesData.categories);
              }
            })
            .catch((_err) => {
              // ignore
            });
        }
      } catch (err) {
        console.error('获取成人内容列表失败:', err);
        setVideos([]);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // 初始化加载
  useEffect(() => {
    loadData(activeSource, activeCategory, page);
  }, [activeSource, activeCategory, page, loadData]);

  // 搜索处理
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchQuery.trim();
    if (!query) {
      loadData(activeSource, activeCategory, 1);
      return;
    }

    setLoading(true);
    setIsSearching(true);
    try {
      const res = await fetch(
        `/api/adult?action=search&q=${encodeURIComponent(query)}`
      );
      if (!res.ok) throw new Error('搜索失败');
      const data = await res.json();
      setVideos(data.list || []);
    } catch (err) {
      console.error('成人内容搜索失败:', err);
      setVideos([]);
    } finally {
      setLoading(false);
    }
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setIsSearching(false);
    loadData(activeSource, activeCategory, 1);
  };

  const handleSourceChange = (key: string) => {
    setActiveSource(key);
    setActiveCategory('');
    setPage(1);
    setSearchQuery('');
    setIsSearching(false);
  };

  const handleCategoryChange = (typeId: string) => {
    setActiveCategory(typeId);
    setPage(1);
    setSearchQuery('');
    setIsSearching(false);
  };

  return (
    <PageLayout activePath='/adult'>
      <div className='px-4 sm:px-10 py-4 sm:py-8 min-h-screen'>
        {/* 顶部标题与提示 */}
        <div className='mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-200/60 dark:border-gray-800 pb-4'>
          <div className='flex items-center gap-3'>
            <div className='flex items-center justify-center w-10 h-10 rounded-xl bg-rose-500/10 text-rose-500 dark:bg-rose-500/20'>
              <Flame className='w-6 h-6' />
            </div>
            <div>
              <h1 className='text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2'>
                18+ 专区
                <span className='text-xs font-medium px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'>
                  独立栏目
                </span>
              </h1>
              <p className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
                色情与成人内容已完全从全站搜索分离，仅在本栏目内浏览与搜索
              </p>
            </div>
          </div>

          {/* 专属搜索框 */}
          <form onSubmit={handleSearch} className='w-full sm:w-80'>
            <div className='relative'>
              <Search className='absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
              <input
                type='text'
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder='在此栏目内搜索片名、演员...'
                className='w-full h-10 rounded-xl bg-gray-50/90 py-2 pl-9 pr-9 text-xs text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-rose-400 focus:bg-white border border-gray-200/60 shadow-sm dark:bg-gray-800/80 dark:text-gray-200 dark:placeholder-gray-500 dark:focus:bg-gray-700 dark:border-gray-700'
              />
              {searchQuery && (
                <button
                  type='button'
                  onClick={handleClearSearch}
                  className='absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200'
                >
                  <X className='w-4 h-4' />
                </button>
              )}
            </div>
          </form>
        </div>

        {/* 资源源切换 */}
        {sources.length > 0 && !isSearching && (
          <div className='mb-4 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide'>
            <span className='text-xs font-semibold text-gray-400 uppercase tracking-wider shrink-0 mr-1'>
              源站:
            </span>
            {sources.map((src) => {
              const active = activeSource === src.key;
              return (
                <button
                  key={src.key}
                  onClick={() => handleSourceChange(src.key)}
                  className={`text-xs px-3.5 py-1.5 rounded-lg font-medium transition-all duration-200 shrink-0 ${
                    active
                      ? 'bg-rose-500 text-white shadow-sm shadow-rose-500/20'
                      : 'bg-gray-100/80 text-gray-600 hover:bg-gray-200/80 dark:bg-gray-800/80 dark:text-gray-300 dark:hover:bg-gray-700'
                  }`}
                >
                  {src.name}
                </button>
              );
            })}
          </div>
        )}

        {/* 分类切换 */}
        {categories.length > 0 && !isSearching && (
          <div className='mb-6 flex items-center gap-1.5 flex-wrap max-h-28 overflow-y-auto pr-1'>
            <button
              onClick={() => handleCategoryChange('')}
              className={`text-xs px-3 py-1 rounded-full transition-all duration-150 ${
                activeCategory === ''
                  ? 'bg-rose-500/10 text-rose-600 font-semibold dark:bg-rose-500/20 dark:text-rose-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
              }`}
            >
              全部
            </button>
            {categories.map((cat) => {
              const catIdStr = cat.type_id.toString();
              const active = activeCategory === catIdStr;
              return (
                <button
                  key={catIdStr}
                  onClick={() => handleCategoryChange(catIdStr)}
                  className={`text-xs px-3 py-1 rounded-full transition-all duration-150 ${
                    active
                      ? 'bg-rose-500/10 text-rose-600 font-semibold dark:bg-rose-500/20 dark:text-rose-300'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                  }`}
                >
                  {cat.type_name}
                </button>
              );
            })}
          </div>
        )}

        {/* 状态展示 */}
        {isSearching && (
          <div className='mb-4 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400'>
            <span>
              搜索结果:{' '}
              <span className='font-semibold text-rose-500'>
                &quot;{searchQuery}&quot;
              </span>{' '}
              (共 {videos.length} 条)
            </span>
            <button
              onClick={handleClearSearch}
              className='text-rose-500 hover:underline flex items-center gap-1'
            >
              <RefreshCw className='w-3 h-3' /> 返回浏览
            </button>
          </div>
        )}

        {/* 视频网格 */}
        {loading ? (
          <div className='flex justify-center items-center h-64'>
            <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-rose-500'></div>
          </div>
        ) : videos.length > 0 ? (
          <div>
            <div className='grid grid-cols-3 gap-x-2 gap-y-12 sm:gap-y-16 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-6'>
              {videos.map((item) => (
                <div key={`${item.source}-${item.id}`} className='w-full'>
                  <VideoCard
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
                </div>
              ))}
            </div>

            {/* 分页控制 (仅在浏览模式显示) */}
            {!isSearching && pageCount > 1 && (
              <div className='mt-12 flex items-center justify-center gap-3'>
                <button
                  disabled={page <= 1}
                  onClick={() => {
                    setPage((p) => Math.max(1, p - 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className='p-2 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                >
                  <ChevronLeft className='w-5 h-5' />
                </button>
                <span className='text-xs font-medium text-gray-600 dark:text-gray-400'>
                  第 {page} / {pageCount} 页
                </span>
                <button
                  disabled={page >= pageCount}
                  onClick={() => {
                    setPage((p) => Math.min(pageCount, p + 1));
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className='p-2 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                >
                  <ChevronRight className='w-5 h-5' />
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className='text-center py-24 text-gray-400 dark:text-gray-500'>
            <Flame className='w-12 h-12 mx-auto text-gray-300 dark:text-gray-600 mb-3' />
            <p className='text-sm'>暂无内容，请尝试切换源站或分类</p>
          </div>
        )}
      </div>
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
