/* eslint-disable no-console,react-hooks/exhaustive-deps,@typescript-eslint/no-explicit-any */

'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getDoubanCategories, getDoubanList } from '@/lib/douban.client';
import {
  applyFilterToSearch,
  DoubanFilter,
  EMPTY_FILTER,
  FILTER_PAGE_SIZE,
  FILTER_POOL_PAGES,
  filterAndSortDouban,
  filterFromSearch,
  isFilterActive,
  sameFilter,
} from '@/lib/douban-filter';
import {
  fetchResourceMeta,
  mergeResourceMeta,
  META_VERIFY_LIMIT,
  needsVerification,
} from '@/lib/meta-client';
import { DoubanItem, DoubanResult } from '@/lib/types';

import CatalogPanel from '@/components/CatalogPanel';
import ChoiceRow, { choiceClass } from '@/components/ChoiceRow';
import DoubanCardSkeleton from '@/components/DoubanCardSkeleton';
import DoubanCustomSelector from '@/components/DoubanCustomSelector';
import DoubanFilterBar from '@/components/DoubanFilterBar';
import DoubanSelector from '@/components/DoubanSelector';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

function DoubanPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [doubanData, setDoubanData] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectorsReady, setSelectorsReady] = useState(false);
  // 筛选：年份、评分、排序。开启后一次取回前 100 部在本地过滤，结果存在 filterPool 里逐页展示
  // 筛选条件同时保存在地址里：刷新、分享、前进后退都能还原
  const [filter, setFilter] = useState<DoubanFilter>(() =>
    filterFromSearch(new URLSearchParams(searchParams.toString()))
  );
  // 多源核对的状态：是否正在核对、是否有批次失败、有多少部片用资源源补全了信息
  const [metaChecking, setMetaChecking] = useState(false);
  const [metaFailed, setMetaFailed] = useState(false);
  const [metaVerified, setMetaVerified] = useState(0);
  const [filterPool, setFilterPool] = useState<DoubanItem[] | null>(null);
  // 本分类的数据里是否有年份、地区、类型信息，用于在没有结果时说明原因
  const [poolInfo, setPoolInfo] = useState({
    year: true,
    region: true,
    genre: true,
  });
  const requestSeqRef = useRef(0);

  // 地址里的筛选条件变化（前进、后退、切换分类）时同步到页面状态
  const filterQuery = searchParams.toString();
  useEffect(() => {
    const fromUrl = filterFromSearch(new URLSearchParams(filterQuery));
    setFilter((prev) => (sameFilter(prev, fromUrl) ? prev : fromUrl));
  }, [filterQuery]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const type = searchParams.get('type') || 'movie';
  const subType = searchParams.get('sub') || '';
  const listKind = searchParams.get('cat') || '';
  const src = searchParams.get('src') || '';
  const catalogEngine: 'bangumi' | 'bilibili' | '' =
    src === 'bangumi' || src === 'bilibili' ? src : '';

  // 获取 runtimeConfig 中的自定义分类数据
  const [customCategories, setCustomCategories] = useState<
    Array<{ name: string; type: 'movie' | 'tv'; query: string }>
  >([]);

  // 选择器状态 - 支持URL参数预设
  const [primarySelection, setPrimarySelection] = useState<string>(() => {
    return type === 'movie' ? listKind || '热门' : '';
  });
  const [secondarySelection, setSecondarySelection] = useState<string>(() => {
    // 如果URL中有sub参数，使用sub参数作为默认选择
    if (subType) return subType;
    if (type === 'movie') return '全部';
    if (type === 'tv') return 'tv';
    if (type === 'show') return 'show';
    return '全部';
  });

  // 获取自定义分类数据
  useEffect(() => {
    const runtimeConfig = (window as any).RUNTIME_CONFIG;
    if (runtimeConfig?.CUSTOM_CATEGORIES?.length > 0) {
      setCustomCategories(runtimeConfig.CUSTOM_CATEGORIES);
    }
  }, []);

  // 初始化时标记选择器为准备好状态
  useEffect(() => {
    // 短暂延迟确保初始状态设置完成
    const timer = setTimeout(() => {
      setSelectorsReady(true);
    }, 50);

    return () => clearTimeout(timer);
  }, []); // 只在组件挂载时执行一次

  // type变化时立即重置selectorsReady（最高优先级）
  useEffect(() => {
    setSelectorsReady(false);
    setLoading(true); // 立即显示loading状态
  }, [type]);

  // 当type变化时重置选择器状态
  useEffect(() => {
    if (type === 'custom' && customCategories.length > 0) {
      // 自定义分类模式：优先选择 movie，如果没有 movie 则选择 tv
      const types = Array.from(
        new Set(customCategories.map((cat) => cat.type))
      );
      if (types.length > 0) {
        // 优先选择 movie，如果没有 movie 则选择 tv
        let selectedType = types[0]; // 默认选择第一个
        if (types.includes('movie')) {
          selectedType = 'movie';
        } else {
          selectedType = 'tv';
        }
        setPrimarySelection(selectedType);

        // 设置选中类型的第一个分类的 query 作为二级选择
        const firstCategory = customCategories.find(
          (cat) => cat.type === selectedType
        );
        if (firstCategory) {
          setSecondarySelection(firstCategory.query);
        }
      }
    } else {
      // 原有逻辑，支持sub参数预设
      if (type === 'movie') {
        setPrimarySelection(listKind || '热门');
        setSecondarySelection(subType || '全部');
      } else if (type === 'tv') {
        setPrimarySelection('');
        setSecondarySelection(subType || 'tv');
      } else if (type === 'show') {
        setPrimarySelection('');
        setSecondarySelection(subType || 'show');
      } else {
        setPrimarySelection('');
        setSecondarySelection(subType || '全部');
      }
    }

    // 使用短暂延迟确保状态更新完成后标记选择器准备好
    const timer = setTimeout(() => {
      setSelectorsReady(true);
    }, 50);

    return () => clearTimeout(timer);
  }, [type, subType, listKind, customCategories]);

  // 生成骨架屏数据
  const skeletonData = Array.from({ length: 25 }, (_, index) => index);

  // 生成API请求参数的辅助函数
  const getRequestParams = useCallback(
    (pageStart: number) => {
      // 当type为tv或show时，kind统一为'tv'，category使用type本身
      if (type === 'tv' || type === 'show') {
        return {
          kind: 'tv' as const,
          category: type,
          type: secondarySelection,
          pageLimit: 25,
          pageStart,
        };
      }

      // 电影类型保持原逻辑
      return {
        kind: type as 'tv' | 'movie',
        category: primarySelection,
        type: secondarySelection,
        pageLimit: 25,
        pageStart,
      };
    },
    [type, primarySelection, secondarySelection]
  );

  // 筛选只用于电影、电视剧、综艺的分类；自定义分类、番组和哔哩不适用
  const filterEnabled =
    !catalogEngine && (type === 'movie' || type === 'tv' || type === 'show');
  const filterOn = filterEnabled && isFilterActive(filter);

  // 防抖的数据加载函数
  const loadInitialData = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      setLoading(true);

      if (filterOn) {
        // 筛选模式：一次取回前 100 部，过滤、排序后逐页展示
        const pages = await Promise.all(
          Array.from({ length: FILTER_POOL_PAGES }, (_, index) =>
            getDoubanCategories(getRequestParams(index * FILTER_PAGE_SIZE), {
              silent: true,
            }).catch(() => null)
          )
        );
        if (seq !== requestSeqRef.current) return;

        let pool = pages.flatMap((page) =>
          page && page.code === 200 && Array.isArray(page.list) ? page.list : []
        );

        // 多源核对：豆瓣没有、但当前筛选用得上的信息，交给资源源核对后再过滤
        const targets = pool
          .filter((item) => needsVerification(item, filter))
          .slice(0, META_VERIFY_LIMIT);
        setMetaChecking(targets.length > 0);
        let failed = 0;
        if (targets.length > 0) {
          const checked = await fetchResourceMeta(targets);
          if (seq !== requestSeqRef.current) return;
          failed = checked.failed;
          pool = pool.map((item) =>
            mergeResourceMeta(item, checked.results.get(item.id))
          );
          setMetaChecking(false);
        }
        setMetaFailed(failed > 0);
        setMetaVerified(pool.filter((item) => (item.verified || 0) > 0).length);

        const filtered = filterAndSortDouban(pool, filter);
        setPoolInfo({
          year: pool.some((item) => /^\d{4}$/.test(item.year)),
          region: pool.some((item) => !!item.regions?.length),
          genre: pool.some((item) => !!item.genres?.length),
        });
        setFilterPool(filtered);
        setDoubanData(filtered.slice(0, FILTER_PAGE_SIZE));
        setHasMore(filtered.length > FILTER_PAGE_SIZE);
        setLoading(false);
        return;
      }

      setFilterPool(null);
      setMetaChecking(false);
      setMetaFailed(false);
      setMetaVerified(0);
      let data: DoubanResult;

      if (type === 'custom') {
        // 自定义分类模式：根据选中的一级和二级选项获取对应的分类
        const selectedCategory = customCategories.find(
          (cat) =>
            cat.type === primarySelection && cat.query === secondarySelection
        );

        if (selectedCategory) {
          data = await getDoubanList({
            tag: selectedCategory.query,
            type: selectedCategory.type,
            pageLimit: 25,
            pageStart: 0,
          });
        } else {
          throw new Error('没有找到对应的分类');
        }
      } else {
        data = await getDoubanCategories(getRequestParams(0));
      }

      // 筛选条件已变，这次的结果不再有效
      if (seq !== requestSeqRef.current) return;

      if (data.code === 200) {
        const list = Array.isArray(data.list) ? data.list : [];
        setDoubanData(list);
        setHasMore(list.length === 25);
        setLoading(false);
      } else {
        throw new Error(data.message || '获取数据失败');
      }
    } catch (err) {
      console.error(err);
    }
  }, [
    type,
    primarySelection,
    secondarySelection,
    getRequestParams,
    customCategories,
    filterOn,
    filter,
  ]);

  // 只在选择器准备好后才加载数据
  useEffect(() => {
    if (catalogEngine) {
      return;
    }
    // 只有在选择器准备好时才开始加载
    if (!selectorsReady) {
      return;
    }

    // 重置页面状态
    setDoubanData([]);
    setCurrentPage(0);
    setHasMore(true);
    setIsLoadingMore(false);

    // 清除之前的防抖定时器
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // 使用防抖机制加载数据，避免连续状态更新触发多次请求
    debounceTimeoutRef.current = setTimeout(() => {
      loadInitialData();
    }, 100); // 100ms 防抖延迟

    // 清理函数
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [
    catalogEngine,
    selectorsReady,
    type,
    primarySelection,
    secondarySelection,
    loadInitialData,
  ]);

  // 单独处理 currentPage 变化（加载更多）
  useEffect(() => {
    if (catalogEngine || currentPage <= 0) {
      return;
    }
    // 筛选模式下结果已全部取回，翻页只是切片
    if (filterPool) {
      const end = (currentPage + 1) * FILTER_PAGE_SIZE;
      setDoubanData(filterPool.slice(0, end));
      setHasMore(filterPool.length > end);
      return;
    }
    if (currentPage > 0) {
      const fetchMoreData = async () => {
        try {
          setIsLoadingMore(true);

          let data: DoubanResult;
          if (type === 'custom') {
            // 自定义分类模式：根据选中的一级和二级选项获取对应的分类
            const selectedCategory = customCategories.find(
              (cat) =>
                cat.type === primarySelection &&
                cat.query === secondarySelection
            );

            if (selectedCategory) {
              data = await getDoubanList({
                tag: selectedCategory.query,
                type: selectedCategory.type,
                pageLimit: 25,
                pageStart: currentPage * 25,
              });
            } else {
              throw new Error('没有找到对应的分类');
            }
          } else {
            data = await getDoubanCategories(
              getRequestParams(currentPage * 25)
            );
          }

          if (data.code === 200) {
            const list = Array.isArray(data.list) ? data.list : [];
            setDoubanData((prev) => [...prev, ...list]);
            setHasMore(list.length === 25);
          } else {
            throw new Error(data.message || '获取数据失败');
          }
        } catch (err) {
          console.error(err);
        } finally {
          setIsLoadingMore(false);
        }
      };

      fetchMoreData();
    }
  }, [
    catalogEngine,
    currentPage,
    type,
    primarySelection,
    secondarySelection,
    customCategories,
    filterPool,
  ]);

  // 设置滚动监听
  useEffect(() => {
    // 如果没有更多数据或正在加载，则不设置监听
    if (!hasMore || isLoadingMore || loading) {
      return;
    }

    // 确保 loadingRef 存在
    if (!loadingRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setCurrentPage((prev) => prev + 1);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadingRef.current);
    observerRef.current = observer;

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, isLoadingMore, loading]);

  // 筛选条件变化：先显示骨架屏，再由 loadInitialData 重新取数
  const handleFilterChange = useCallback(
    (next: DoubanFilter) => {
      setLoading(true);
      setFilter(next);
      const params = applyFilterToSearch(
        new URLSearchParams(searchParams.toString()),
        next
      );
      const query = params.toString();
      router.replace(query ? `/douban?${query}` : '/douban', { scroll: false });
    },
    [router, searchParams]
  );

  // 处理选择器变化
  const handlePrimaryChange = useCallback(
    (value: string) => {
      // 只有当值真正改变时才设置loading状态
      if (value !== primarySelection) {
        setLoading(true);

        // 如果是自定义分类模式，同时更新一级和二级选择器
        if (type === 'custom' && customCategories.length > 0) {
          const firstCategory = customCategories.find(
            (cat) => cat.type === value
          );
          if (firstCategory) {
            // 批量更新状态，避免多次触发数据加载
            setPrimarySelection(value);
            setSecondarySelection(firstCategory.query);
          } else {
            setPrimarySelection(value);
          }
        } else {
          setPrimarySelection(value);
        }
      }
    },
    [primarySelection, type, customCategories]
  );

  const handleSecondaryChange = useCallback(
    (value: string) => {
      // 只有当值真正改变时才设置loading状态
      if (value !== secondarySelection) {
        setLoading(true);
        setSecondarySelection(value);
      }
    },
    [secondarySelection]
  );

  const getPageTitle = () => {
    if (catalogEngine === 'bangumi') return '番组计划';
    if (catalogEngine === 'bilibili') return '哔哩哔哩';
    return type === 'movie'
      ? '电影'
      : type === 'tv'
      ? '电视剧'
      : type === 'show'
      ? '综艺'
      : '自定义';
  };

  const openEngine = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('src', next);
    else params.delete('src');
    const query = params.toString();
    router.replace(query ? `/douban?${query}` : '/douban', { scroll: false });
  };

  const getActivePath = () => {
    // 番组、哔哩单独高亮，不落到豆瓣的动漫分类上。
    if (catalogEngine) return `/douban?src=${catalogEngine}`;
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (subType) params.set('sub', subType);

    const queryString = params.toString();
    return `/douban${queryString ? `?${queryString}` : ''}`;
  };

  return (
    <PageLayout activePath={getActivePath()}>
      <div className='px-4 sm:px-10 py-4 sm:py-8 overflow-visible'>
        {/* 页面标题和选择器 */}
        <div className='mb-6 sm:mb-8 space-y-4 sm:space-y-6'>
          {/* 页面标题 */}
          <div>
            <h1 className='text-2xl sm:text-3xl font-bold text-gray-800 dark:text-gray-200'>
              {getPageTitle()}
            </h1>
          </div>

          <ChoiceRow
            options={[
              { value: '', label: '豆瓣' },
              { value: 'bangumi', label: '番组计划' },
              { value: 'bilibili', label: '哔哩哔哩' },
            ]}
            value={catalogEngine}
            onChange={openEngine}
          />

          {/* 选择器组件 */}
          {catalogEngine ? null : type !== 'custom' ? (
            <div>
              <DoubanSelector
                type={type as 'movie' | 'tv' | 'show'}
                primarySelection={primarySelection}
                secondarySelection={secondarySelection}
                onPrimaryChange={handlePrimaryChange}
                onSecondaryChange={handleSecondaryChange}
              />
            </div>
          ) : (
            <div>
              <DoubanCustomSelector
                customCategories={customCategories}
                primarySelection={primarySelection}
                secondarySelection={secondarySelection}
                onPrimaryChange={handlePrimaryChange}
                onSecondaryChange={handleSecondaryChange}
              />
            </div>
          )}

          {filterEnabled ? (
            <DoubanFilterBar
              value={filter}
              onChange={handleFilterChange}
              currentYear={new Date().getFullYear()}
            />
          ) : null}
        </div>

        {catalogEngine ? (
          <div className='max-w-[95%] mx-auto mt-8'>
            <CatalogPanel engine={catalogEngine} />
          </div>
        ) : (
          <div className='mt-8 overflow-visible'>
            {filterOn && (metaChecking || !loading) ? (
              <div className='mb-4 space-y-1 text-sm text-gray-500 dark:text-gray-400'>
                {metaChecking ? (
                  <p>正在用资源源核对地区和题材…</p>
                ) : (filterPool?.length ?? 0) > 0 ? (
                  <p>
                    在本分类热门影片中筛选，共 {filterPool?.length ?? 0} 部
                    {metaVerified > 0
                      ? `，地区和题材已用资源源核对（最多核对前 ${META_VERIFY_LIMIT} 部）`
                      : ''}
                  </p>
                ) : null}
                {metaFailed && !metaChecking ? (
                  <p>部分影片核对失败，结果可能不完整</p>
                ) : null}
              </div>
            ) : null}
            {/* 内容网格：与上方的分类、筛选行左对齐 */}
            <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-10 px-0 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:gap-x-8 sm:gap-y-12'>
              {loading || !selectorsReady
                ? // 显示骨架屏
                  skeletonData.map((index) => (
                    <DoubanCardSkeleton key={index} />
                  ))
                : // 显示实际数据
                  doubanData.map((item, index) => (
                    <div key={`${item.title}-${index}`} className='w-full'>
                      <VideoCard
                        from='douban'
                        title={item.title}
                        poster={item.poster}
                        douban_id={item.id}
                        rate={item.rate}
                        year={item.year}
                        type={type === 'movie' ? 'movie' : ''} // 电影类型严格控制，tv 不控
                      />
                    </div>
                  ))}
            </div>

            {/* 加载更多指示器 */}
            {hasMore && !loading && (
              <div
                ref={(el) => {
                  if (el && el.offsetParent !== null) {
                    (
                      loadingRef as React.MutableRefObject<HTMLDivElement | null>
                    ).current = el;
                  }
                }}
                className='flex justify-center mt-12 py-8'
              >
                {isLoadingMore && (
                  <div className='flex items-center gap-2'>
                    <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-green-500'></div>
                    <span className='text-gray-600'>加载中...</span>
                  </div>
                )}
              </div>
            )}

            {/* 没有更多数据提示 */}
            {!hasMore && doubanData.length > 0 && (
              <div className='text-center text-gray-500 py-8'>
                已加载全部内容
              </div>
            )}

            {/* 空状态 */}
            {!loading &&
              doubanData.length === 0 &&
              (filterOn ? (
                <div className='flex flex-col items-center gap-3 py-8 text-center text-gray-500 dark:text-gray-400'>
                  <p>
                    {filter.year && !poolInfo.year
                      ? '该分类暂不提供年份信息，可以试试其他条件'
                      : filter.region && !poolInfo.region
                      ? '该分类暂不提供地区信息，可以试试其他条件'
                      : filter.genre && !poolInfo.genre
                      ? '该分类暂不提供类型信息，可以试试其他条件'
                      : metaFailed
                      ? '部分影片核对失败，可以稍后重试或换个条件'
                      : '没有符合条件的影片'}
                  </p>
                  <button
                    type='button'
                    onClick={() => handleFilterChange(EMPTY_FILTER)}
                    className={choiceClass(false)}
                  >
                    清除筛选
                  </button>
                </div>
              ) : (
                <div className='text-center text-gray-500 py-8'>
                  暂无相关内容
                </div>
              ))}
          </div>
        )}
      </div>
    </PageLayout>
  );
}

export default function DoubanPage() {
  return (
    <Suspense>
      <DoubanPageClient />
    </Suspense>
  );
}
