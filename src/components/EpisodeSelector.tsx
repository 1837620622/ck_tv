/* eslint-disable @next/next/no-img-element */

import { useRouter } from 'next/navigation';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { SearchResult } from '@/lib/types';
import { processImageUrl } from '@/lib/utils';

function sourceKey(source: SearchResult): string {
  return `${source.source}:${source.id}`;
}

// 只拉 m3u8 清单，不下载正片。测不到（跨域失败）就保持原来的线路顺序。
async function probeManifest(
  url: string,
  parent: AbortSignal
): Promise<number | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2200);
  const stop = () => controller.abort();
  parent.addEventListener('abort', stop);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      mode: 'cors',
    });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.includes('#EXTM3U')) return null;
    return Math.max(1, Math.round(performance.now() - started));
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    parent.removeEventListener('abort', stop);
  }
}

interface EpisodeSelectorProps {
  /** 总集数 */
  totalEpisodes: number;
  /** 每页显示多少集，默认 50 */
  episodesPerPage?: number;
  /** 当前选中的集数（1 开始） */
  value?: number;
  /** 用户点击选集后的回调 */
  onChange?: (episodeNumber: number) => void;
  /** 换源相关 */
  onSourceChange?: (source: string, id: string, title: string) => void;
  currentSource?: string;
  currentId?: string;
  videoTitle?: string;
  videoYear?: string;
  availableSources?: SearchResult[];
  sourceSearchLoading?: boolean;
  sourceSearchError?: string | null;
}

/**
 * 选集组件，支持分页、自动滚动聚焦当前分页标签，以及换源功能。
 */
const EpisodeSelector: React.FC<EpisodeSelectorProps> = ({
  totalEpisodes,
  episodesPerPage = 50,
  value = 1,
  onChange,
  onSourceChange,
  currentSource,
  currentId,
  videoTitle,
  availableSources = [],
  sourceSearchLoading = false,
  sourceSearchError = null,
}) => {
  const router = useRouter();
  const pageCount = Math.ceil(totalEpisodes / episodesPerPage);

  // 主要的 tab 状态：'episodes' 或 'sources'
  // 当只有一集时默认展示 "换源"，并隐藏 "选集" 标签
  const [activeTab, setActiveTab] = useState<'episodes' | 'sources'>(
    totalEpisodes > 1 ? 'episodes' : 'sources'
  );

  // 当前分页索引（0 开始）
  const initialPage = Math.floor((value - 1) / episodesPerPage);
  const [currentPage, setCurrentPage] = useState<number>(initialPage);

  // 是否倒序显示
  const [descending, setDescending] = useState<boolean>(false);
  const [latencyMs, setLatencyMs] = useState<Record<string, number>>({});

  useEffect(() => {
    if (availableSources.length === 0) return;
    const parent = new AbortController();
    const timer = window.setTimeout(() => {
      const jobs: { key: string; url: string }[] = [];
      const missed: Record<string, number> = {};
      availableSources.forEach((source) => {
        const url = source.episodes?.find((item) => item.includes('.m3u8'));
        const key = sourceKey(source);
        // 分享页地址测不出清单延迟，直接标未测到，避免一直停在测速中。
        if (url) jobs.push({ key, url });
        else missed[key] = -1;
      });
      if (Object.keys(missed).length > 0) {
        setLatencyMs((current) => ({ ...current, ...missed }));
      }
      let cursor = 0;
      const worker = async () => {
        while (cursor < jobs.length && !parent.signal.aborted) {
          const job = jobs[cursor];
          cursor += 1;
          const latency = await probeManifest(job.url, parent.signal);
          if (parent.signal.aborted) continue;
          const value = latency ?? -1;
          setLatencyMs((current) =>
            current[job.key] === value
              ? current
              : { ...current, [job.key]: value }
          );
        }
      };
      void Promise.all([worker(), worker()]);
    }, 1200);
    return () => {
      window.clearTimeout(timer);
      parent.abort();
    };
  }, [availableSources]);

  // 根据 descending 状态计算实际显示的分页索引
  const displayPage = useMemo(() => {
    if (descending) {
      return pageCount - 1 - currentPage;
    }
    return currentPage;
  }, [currentPage, descending, pageCount]);

  // 升序分页标签
  const categoriesAsc = useMemo(() => {
    return Array.from({ length: pageCount }, (_, i) => {
      const start = i * episodesPerPage + 1;
      const end = Math.min(start + episodesPerPage - 1, totalEpisodes);
      return { start, end };
    });
  }, [pageCount, episodesPerPage, totalEpisodes]);

  // 根据 descending 状态决定分页标签的排序和内容
  const categories = useMemo(() => {
    if (descending) {
      // 倒序时，label 也倒序显示
      return [...categoriesAsc]
        .reverse()
        .map(({ start, end }) => `${end}-${start}`);
    }
    return categoriesAsc.map(({ start, end }) => `${start}-${end}`);
  }, [categoriesAsc, descending]);

  const categoryContainerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 当分页切换时，将激活的分页标签滚动到视口中间
  useEffect(() => {
    const btn = buttonRefs.current[displayPage];
    const container = categoryContainerRef.current;
    if (btn && container) {
      // 手动计算滚动位置，只滚动分页标签容器
      const containerRect = container.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const scrollLeft = container.scrollLeft;

      // 计算按钮相对于容器的位置
      const btnLeft = btnRect.left - containerRect.left + scrollLeft;
      const btnWidth = btnRect.width;
      const containerWidth = containerRect.width;

      // 计算目标滚动位置，使按钮居中
      const targetScrollLeft = btnLeft - (containerWidth - btnWidth) / 2;

      // 平滑滚动到目标位置
      container.scrollTo({
        left: targetScrollLeft,
        behavior: 'smooth',
      });
    }
  }, [displayPage, pageCount]);

  // 处理换源tab点击，只在点击时才搜索
  const handleSourceTabClick = () => {
    setActiveTab('sources');
  };

  const handleCategoryClick = useCallback(
    (index: number) => {
      if (descending) {
        // 在倒序时，需要将显示索引转换为实际索引
        setCurrentPage(pageCount - 1 - index);
      } else {
        setCurrentPage(index);
      }
    },
    [descending, pageCount]
  );

  const handleEpisodeClick = useCallback(
    (episodeNumber: number) => {
      onChange?.(episodeNumber);
    },
    [onChange]
  );

  const handleSourceClick = useCallback(
    (source: SearchResult) => {
      onSourceChange?.(source.source, source.id, source.title);
    },
    [onSourceChange]
  );

  const currentStart = currentPage * episodesPerPage + 1;
  const currentEnd = Math.min(
    currentStart + episodesPerPage - 1,
    totalEpisodes
  );

  return (
    <div className='md:ml-2 px-4 py-0 h-full rounded-xl bg-black/10 dark:bg-white/5 flex flex-col border border-white/0 dark:border-white/30 overflow-hidden'>
      {/* 主要的 Tab 切换 - 无缝融入设计 */}
      <div className='flex mb-1 -mx-6 flex-shrink-0'>
        {totalEpisodes > 1 && (
          <div
            onClick={() => setActiveTab('episodes')}
            className={`flex-1 py-3 px-6 text-center cursor-pointer transition-all duration-200 font-medium
              ${
                activeTab === 'episodes'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-gray-700 hover:text-green-600 bg-black/5 dark:bg-white/5 dark:text-gray-300 dark:hover:text-green-400 hover:bg-black/3 dark:hover:bg-white/3'
              }
            `.trim()}
          >
            选集
          </div>
        )}
        <div
          onClick={handleSourceTabClick}
          className={`flex-1 py-3 px-6 text-center cursor-pointer transition-all duration-200 font-medium
            ${
              activeTab === 'sources'
                ? 'text-green-600 dark:text-green-400'
                : 'text-gray-700 hover:text-green-600 bg-black/5 dark:bg-white/5 dark:text-gray-300 dark:hover:text-green-400 hover:bg-black/3 dark:hover:bg-white/3'
            }
          `.trim()}
        >
          换源
        </div>
      </div>

      {/* 选集 Tab 内容 */}
      {activeTab === 'episodes' && (
        <>
          {/* 分类标签 */}
          <div className='flex items-center gap-4 mb-4 border-b border-gray-300 dark:border-gray-700 -mx-6 px-6 flex-shrink-0'>
            <div className='flex-1 overflow-x-auto' ref={categoryContainerRef}>
              <div className='flex gap-2 min-w-max'>
                {categories.map((label, idx) => {
                  const isActive = idx === displayPage;
                  return (
                    <button
                      key={label}
                      ref={(el) => {
                        buttonRefs.current[idx] = el;
                      }}
                      onClick={() => handleCategoryClick(idx)}
                      className={`w-20 relative py-2 text-sm font-medium transition-colors whitespace-nowrap flex-shrink-0 text-center 
                        ${
                          isActive
                            ? 'text-green-500 dark:text-green-400'
                            : 'text-gray-700 hover:text-green-600 dark:text-gray-300 dark:hover:text-green-400'
                        }
                      `.trim()}
                    >
                      {label}
                      {isActive && (
                        <div className='absolute bottom-0 left-0 right-0 h-0.5 bg-green-500 dark:bg-green-400' />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            {/* 向上/向下按钮 */}
            <button
              className='flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-gray-700 hover:text-green-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-green-400 dark:hover:bg-white/20 transition-colors transform translate-y-[-4px]'
              onClick={() => {
                // 切换集数排序（正序/倒序）
                setDescending((prev) => !prev);
              }}
            >
              <svg
                className='w-4 h-4'
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4'
                />
              </svg>
            </button>
          </div>

          {/* 集数网格 */}
          <div className='grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] auto-rows-[40px] gap-x-3 gap-y-3 overflow-y-auto h-full pb-4'>
            {(() => {
              const len = currentEnd - currentStart + 1;
              const episodes = Array.from({ length: len }, (_, i) =>
                descending ? currentEnd - i : currentStart + i
              );
              return episodes;
            })().map((episodeNumber) => {
              const isActive = episodeNumber === value;
              return (
                <button
                  key={episodeNumber}
                  onClick={() => handleEpisodeClick(episodeNumber - 1)}
                  className={`h-10 flex items-center justify-center text-sm font-medium rounded-md transition-all duration-200 
                    ${
                      isActive
                        ? 'bg-green-500 text-white shadow-lg shadow-green-500/25 dark:bg-green-600'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300 hover:scale-105 dark:bg-white/10 dark:text-gray-300 dark:hover:bg-white/20'
                    }`.trim()}
                >
                  {episodeNumber}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 换源 Tab 内容 */}
      {activeTab === 'sources' && (
        <div className='flex flex-col h-full mt-4'>
          {sourceSearchLoading && (
            <div className='flex items-center justify-center py-8'>
              <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-green-500'></div>
              <span className='ml-2 text-sm text-gray-600 dark:text-gray-300'>
                搜索中...
              </span>
            </div>
          )}

          {sourceSearchError && (
            <div className='flex items-center justify-center py-8'>
              <div className='text-center'>
                <div className='text-red-500 text-2xl mb-2'>⚠️</div>
                <p className='text-sm text-red-600 dark:text-red-400'>
                  {sourceSearchError}
                </p>
              </div>
            </div>
          )}

          {!sourceSearchLoading &&
            !sourceSearchError &&
            availableSources.length === 0 && (
              <div className='flex items-center justify-center py-8'>
                <div className='text-center'>
                  <div className='text-gray-400 text-2xl mb-2'>📺</div>
                  <p className='text-sm text-gray-600 dark:text-gray-300'>
                    暂无可用的换源
                  </p>
                </div>
              </div>
            )}

          {!sourceSearchLoading &&
            !sourceSearchError &&
            availableSources.length > 0 && (
              <div className='flex-1 overflow-y-auto space-y-1.5 pb-20'>
                {[...availableSources]
                  .sort((a, b) => {
                    const rankA = a.source_rank ?? 999;
                    const rankB = b.source_rank ?? 999;
                    const readLatency = (item: SearchResult) => {
                      const value = latencyMs[sourceKey(item)];
                      return value && value > 0 ? value : 480;
                    };
                    const latencyA = readLatency(a);
                    const latencyB = readLatency(b);
                    // 配置顺序仍是基准。清单延迟大约每差一个名次抵 180ms，测不到不降级。
                    const scoreA = latencyA + (rankA - 1) * 180;
                    const scoreB = latencyB + (rankB - 1) * 180;
                    if (scoreA !== scoreB) return scoreA - scoreB;
                    return rankA - rankB;
                  })
                  .map((source, index) => {
                    const isCurrentSource =
                      source.source?.toString() === currentSource?.toString() &&
                      source.id?.toString() === currentId?.toString();
                    const latency = latencyMs[sourceKey(source)];
                    const episodeCount =
                      source.episodes?.length || source.episode_count || 0;
                    return (
                      <div
                        key={`${source.source}-${source.id}`}
                        onClick={() =>
                          !isCurrentSource && handleSourceClick(source)
                        }
                        className={`flex items-center gap-3 px-2 py-2 rounded-md select-none
                      ${
                        isCurrentSource
                          ? 'bg-green-500/10 dark:bg-green-500/15 border border-green-600/40'
                          : 'border border-transparent hover:bg-gray-100 dark:hover:bg-white/5 cursor-pointer'
                      }`.trim()}
                      >
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center text-sm font-semibold ${
                            isCurrentSource
                              ? 'bg-green-600 text-white'
                              : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'
                          }`}
                        >
                          {index + 1}
                        </div>
                        <div className='min-w-0 flex-1'>
                          <div className='flex items-center justify-between gap-2'>
                            <span className='truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
                              {source.source_name}
                            </span>
                            <span className='shrink-0 text-xs text-gray-500 dark:text-gray-400'>
                              {isCurrentSource
                                ? '正在播放'
                                : latency == null
                                ? '测速中'
                                : latency > 0
                                ? `${latency} ms`
                                : '未测到'}
                            </span>
                          </div>
                          <div className='mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400'>
                            {episodeCount > 1 ? `${episodeCount} 集 · ` : ''}
                            {source.title}
                          </div>
                        </div>
                        {source.poster && (
                          <img
                            src={processImageUrl(source.poster)}
                            alt=''
                            className='h-12 w-8 shrink-0 rounded-sm object-cover'
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              target.style.display = 'none';
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                <div className='flex-shrink-0 mt-auto pt-2 border-t border-gray-400 dark:border-gray-700'>
                  <button
                    onClick={() => {
                      if (videoTitle) {
                        router.push(
                          `/search?q=${encodeURIComponent(videoTitle)}`
                        );
                      }
                    }}
                    className='w-full text-center text-xs text-gray-500 dark:text-gray-400 hover:text-green-500 dark:hover:text-green-400 transition-colors py-2'
                  >
                    影片匹配有误？点击去搜索
                  </button>
                </div>
              </div>
            )}
        </div>
      )}
    </div>
  );
};

export default EpisodeSelector;
