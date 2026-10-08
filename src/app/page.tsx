/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

// 客户端收藏 API
import {
  clearAllFavorites,
  getAllFavorites,
  getAllPlayRecords,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { getDoubanCategories } from '@/lib/douban.client';
import { DoubanItem } from '@/lib/types';

import CapsuleSwitch from '@/components/CapsuleSwitch';
import ContinueWatching from '@/components/ContinueWatching';
import PageLayout from '@/components/PageLayout';
import ScrollableRow from '@/components/ScrollableRow';
import VideoCard from '@/components/VideoCard';

const POSTER_CARD =
  'min-w-[31%] w-[31%] max-w-[132px] sm:min-w-[144px] sm:w-36 sm:max-w-none md:w-40 lg:w-44';

const homeEntries = [
  { label: '电影', href: '/douban?type=movie' },
  { label: '剧集', href: '/douban?type=tv' },
  { label: '动漫', href: '/douban?type=tv&sub=tv_animation' },
  { label: '综艺', href: '/douban?type=show' },
  { label: '纪录片', href: '/douban?type=tv&sub=tv_documentary' },
  { label: '番组', href: '/douban?src=bangumi' },
  { label: '哔哩', href: '/douban?src=bilibili' },
];

function SectionTitle({ title, href }: { title: string; href?: string }) {
  return (
    <div className='mb-3 flex items-center justify-between'>
      <h2 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
        <span className='h-4 w-0.5 bg-green-600' aria-hidden />
        {title}
      </h2>
      {href && (
        <Link
          href={href}
          className='flex items-center text-sm text-gray-500 hover:text-green-700 dark:text-gray-400 dark:hover:text-green-400'
        >
          查看更多
          <ChevronRight className='ml-0.5 h-4 w-4' />
        </Link>
      )}
    </div>
  );
}

function RowSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className={POSTER_CARD}>
          <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 animate-pulse dark:bg-gray-800' />
          <div className='mt-2 h-4 rounded bg-gray-200 animate-pulse dark:bg-gray-800' />
        </div>
      ))}
    </>
  );
}

function PosterGrid({
  items,
  cardType,
  className = 'grid min-w-0 grid-cols-3 gap-x-2 gap-y-4 sm:grid-cols-4 sm:gap-x-3 lg:grid-cols-5 xl:grid-cols-6',
}: {
  items: DoubanItem[];
  cardType?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {items.map((item) => (
        <VideoCard
          key={item.id}
          from='douban'
          title={item.title}
          poster={item.poster}
          douban_id={item.id}
          rate={item.rate}
          year={item.year}
          type={cardType}
        />
      ))}
    </div>
  );
}

function HomeRow({
  title,
  href,
  loading,
  items,
  cardType,
}: {
  title: string;
  href: string;
  loading: boolean;
  items: DoubanItem[];
  cardType?: string;
}) {
  if (!loading && items.length === 0) return null;

  return (
    <section className='mb-8'>
      <SectionTitle title={title} href={href} />
      <ScrollableRow>
        {loading ? (
          <RowSkeleton />
        ) : (
          items.map((item) => (
            <div key={item.id} className={POSTER_CARD}>
              <VideoCard
                from='douban'
                title={item.title}
                poster={item.poster}
                douban_id={item.id}
                rate={item.rate}
                year={item.year}
                type={cardType}
              />
            </div>
          ))
        )}
      </ScrollableRow>
    </section>
  );
}

async function loadDoubanRow(params: {
  kind: 'movie' | 'tv';
  category: string;
  type: string;
}): Promise<DoubanItem[]> {
  try {
    const data = await getDoubanCategories(params, { silent: true });
    return data.code === 200 && Array.isArray(data.list) ? data.list : [];
  } catch (error) {
    console.error('获取豆瓣数据失败:', error);
    return [];
  }
}

async function loadCatalogRow(
  engine: string,
  kind: string
): Promise<DoubanItem[]> {
  try {
    const response = await fetch(
      `/api/catalog?engine=${engine}&kind=${encodeURIComponent(kind)}&page=1`,
      { cache: 'no-store' }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.list) ? data.list.slice(0, 16) : [];
  } catch (error) {
    console.error('获取片库数据失败:', error);
    return [];
  }
}

function HomeClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab =
    searchParams.get('tab') === 'favorites' ? 'favorites' : 'home';
  const [hotMovies, setHotMovies] = useState<DoubanItem[]>([]);
  const [latestMovies, setLatestMovies] = useState<DoubanItem[]>([]);
  const [hotTvShows, setHotTvShows] = useState<DoubanItem[]>([]);
  const [hotAnime, setHotAnime] = useState<DoubanItem[]>([]);
  const [hotVarietyShows, setHotVarietyShows] = useState<DoubanItem[]>([]);
  const [hotDocumentaries, setHotDocumentaries] = useState<DoubanItem[]>([]);
  const [bangumiRow, setBangumiRow] = useState<DoubanItem[]>([]);
  const [bilibiliRow, setBilibiliRow] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);

  // 收藏夹数据
  type FavoriteItem = {
    id: string;
    source: string;
    title: string;
    poster: string;
    episodes: number;
    source_name: string;
    currentEpisode?: number;
    search_title?: string;
  };

  const [favoriteItems, setFavoriteItems] = useState<FavoriteItem[]>([]);

  useEffect(() => {
    const fetchDoubanData = async () => {
      try {
        setLoading(true);

        const [movies, latest, tvShows, anime, varietyShows, documentaries] =
          await Promise.all([
            loadDoubanRow({ kind: 'movie', category: '热门', type: '全部' }),
            loadDoubanRow({ kind: 'movie', category: '最新', type: '全部' }),
            loadDoubanRow({ kind: 'tv', category: 'tv', type: 'tv' }),
            loadDoubanRow({
              kind: 'tv',
              category: 'tv',
              type: 'tv_animation',
            }),
            loadDoubanRow({ kind: 'tv', category: 'show', type: 'show' }),
            loadDoubanRow({
              kind: 'tv',
              category: 'tv',
              type: 'tv_documentary',
            }),
          ]);

        setHotMovies(movies);
        setLatestMovies(latest);
        setHotTvShows(tvShows);
        setHotAnime(anime);
        setHotVarietyShows(varietyShows);
        setHotDocumentaries(documentaries);
      } finally {
        setLoading(false);
      }
    };

    fetchDoubanData();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadCatalog = async () => {
      const [bangumi, bilibili] = await Promise.all([
        loadCatalogRow('bangumi', 'anime'),
        loadCatalogRow('bilibili', 'bangumi'),
      ]);
      if (cancelled) return;
      setBangumiRow(bangumi);
      setBilibiliRow(bilibili);
      setCatalogLoading(false);
    };
    loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  // 处理收藏数据更新的函数
  const updateFavoriteItems = async (allFavorites: Record<string, any>) => {
    const allPlayRecords = await getAllPlayRecords();

    // 根据保存时间排序（从近到远）
    const sorted = Object.entries(allFavorites)
      .sort(([, a], [, b]) => b.save_time - a.save_time)
      .map(([key, fav]) => {
        const plusIndex = key.indexOf('+');
        const source = key.slice(0, plusIndex);
        const id = key.slice(plusIndex + 1);

        // 查找对应的播放记录，获取当前集数
        const playRecord = allPlayRecords[key];
        const currentEpisode = playRecord?.index;

        return {
          id,
          source,
          title: fav.title,
          year: fav.year,
          poster: fav.cover,
          episodes: fav.total_episodes,
          source_name: fav.source_name,
          currentEpisode,
          search_title: fav?.search_title,
        } as FavoriteItem;
      });
    setFavoriteItems(sorted);
  };

  // 当切换到收藏夹时加载收藏数据
  useEffect(() => {
    if (activeTab !== 'favorites') return;

    const loadFavorites = async () => {
      const allFavorites = await getAllFavorites();
      await updateFavoriteItems(allFavorites);
    };

    loadFavorites();

    // 监听收藏更新事件
    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (newFavorites: Record<string, any>) => {
        updateFavoriteItems(newFavorites);
      }
    );

    return unsubscribe;
  }, [activeTab]);

  return (
    <PageLayout>
      <div className='overflow-x-hidden px-3 py-4 sm:px-4 sm:py-6 lg:px-8 lg:py-8'>
        {/* 顶部 Tab 切换 */}
        <div className='mb-5 flex justify-center'>
          <CapsuleSwitch
            options={[
              { label: '首页', value: 'home' },
              { label: '收藏夹', value: 'favorites' },
            ]}
            active={activeTab}
            onChange={(value) => {
              router.replace(value === 'favorites' ? '/?tab=favorites' : '/', {
                scroll: false,
              });
            }}
          />
        </div>

        <div className='max-w-[95%] mx-auto'>
          {activeTab === 'favorites' ? (
            // 收藏夹视图
            <section className='mb-8'>
              <div className='mb-4 flex items-center justify-between'>
                <h2 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
                  <span className='h-4 w-0.5 bg-green-600' aria-hidden />
                  我的收藏
                </h2>
                {favoriteItems.length > 0 && (
                  <button
                    className='text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                    onClick={async () => {
                      await clearAllFavorites();
                      setFavoriteItems([]);
                    }}
                  >
                    清空
                  </button>
                )}
              </div>
              <div className='grid grid-cols-3 gap-x-2 gap-y-8 sm:grid-cols-4 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'>
                {favoriteItems.map((item) => (
                  <div key={item.id + item.source} className='w-full'>
                    <VideoCard
                      query={item.search_title}
                      {...item}
                      from='favorite'
                      type={item.episodes > 1 ? 'tv' : ''}
                    />
                  </div>
                ))}
                {favoriteItems.length === 0 && (
                  <div className='col-span-full text-center text-gray-500 py-8 dark:text-gray-400'>
                    暂无收藏内容
                  </div>
                )}
              </div>
            </section>
          ) : (
            // 首页视图
            <>
              <nav className='mb-6 flex items-center gap-x-1 overflow-x-auto text-sm'>
                {homeEntries.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className='shrink-0 px-3 py-1.5 text-gray-700 hover:text-green-700 dark:text-gray-300 dark:hover:text-green-400'
                  >
                    {item.label}
                  </Link>
                ))}
                <Link
                  href='/adult'
                  className='ml-1 shrink-0 border-l border-gray-200 px-3 py-1.5 text-gray-400 hover:text-gray-600 dark:border-gray-700 dark:hover:text-gray-300'
                >
                  18+
                </Link>
                <Link
                  href='/huangguo'
                  className='shrink-0 px-3 py-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                >
                  AI黄果
                </Link>
              </nav>

              <ContinueWatching />

              <section className='mb-8'>
                <SectionTitle
                  title='热度最高'
                  href='/douban?type=movie&cat=热门'
                />
                {loading ? (
                  <div className='grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5'>
                    {Array.from({ length: 6 }).map((_, index) => (
                      <div
                        key={index}
                        className='aspect-[2/3] rounded-md bg-gray-200 animate-pulse dark:bg-gray-800'
                      />
                    ))}
                  </div>
                ) : (
                  <PosterGrid items={hotMovies.slice(0, 18)} cardType='movie' />
                )}
              </section>

              <section className='mb-8'>
                <SectionTitle
                  title='最新上线'
                  href='/douban?type=movie&cat=最新'
                />
                {loading ? (
                  <div className='grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6'>
                    {Array.from({ length: 6 }).map((_, index) => (
                      <div
                        key={index}
                        className='aspect-[2/3] rounded-md bg-gray-200 animate-pulse dark:bg-gray-800'
                      />
                    ))}
                  </div>
                ) : (
                  <PosterGrid
                    items={(() => {
                      const used = new Set(
                        hotMovies.slice(0, 13).map((item) => item.id)
                      );
                      const fresh = latestMovies.filter(
                        (item) => !used.has(item.id)
                      );
                      const list = fresh.length > 0 ? fresh : latestMovies;
                      return list.slice(0, 12);
                    })()}
                    cardType='movie'
                  />
                )}
              </section>

              <HomeRow
                title='热门剧集'
                href='/douban?type=tv'
                loading={loading}
                items={hotTvShows}
              />
              <HomeRow
                title='热门动漫'
                href='/douban?type=tv&sub=tv_animation'
                loading={loading}
                items={hotAnime}
              />
              <HomeRow
                title='热门综艺'
                href='/douban?type=show'
                loading={loading}
                items={hotVarietyShows}
              />
              <HomeRow
                title='热门纪录片'
                href='/douban?type=tv&sub=tv_documentary'
                loading={loading}
                items={hotDocumentaries}
              />
              <HomeRow
                title='番组高分'
                href='/douban?src=bangumi'
                loading={catalogLoading}
                items={bangumiRow}
              />
              <HomeRow
                title='哔哩番剧'
                href='/douban?src=bilibili'
                loading={catalogLoading}
                items={bilibiliRow}
              />
            </>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeClient />
    </Suspense>
  );
}
