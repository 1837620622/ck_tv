/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import Artplayer from 'artplayer';
import Hls from 'hls.js';
import { Heart } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  isAirPlaying,
  loadNativeSource,
  supportsNativeHls,
} from '@/lib/airplay';
import {
  deleteFavorite,
  deletePlayRecord,
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getSkipConfig,
  isFavorited,
  saveFavorite,
  savePlayRecord,
  saveSkipConfig,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import {
  freshHuangguoDirectUrl,
  parseHuangguoPlaylist,
} from '@/lib/huangguo-media';
import { filterAdBreaks } from '@/lib/m3u8-ads';
import { pickPlayable, repairTitle } from '@/lib/match-title';
import {
  bindMediaActions,
  setMediaInfo,
  setMediaPlaybackState,
  setMediaPosition,
} from '@/lib/media-session';
import {
  readAutoNext,
  readVolume,
  writeAutoNext,
  writeVolume,
} from '@/lib/player-prefs';
import { releaseMedia, silenceOtherMedia } from '@/lib/release-media';
import {
  DETAIL_CACHE_VERSION,
  SEARCH_CACHE_VERSION,
  shouldReplaceListing,
} from '@/lib/search-cache';
import { SearchResult } from '@/lib/types';
import { processImageUrl } from '@/lib/utils';
import { type ScreenWakeLock, createScreenWakeLock } from '@/lib/wake-lock';

import CloudflareAISubtitle from '@/components/CloudflareAISubtitle';
import EpisodeSelector from '@/components/EpisodeSelector';
import PageLayout from '@/components/PageLayout';
import ScamNotice from '@/components/ScamNotice';
import TVCastModal from '@/components/TVCastModal';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
    __ckTeardown?: () => void;
  }
}

// 扫码、投屏链接里的 ep 参数是从 0 开始的集数；不是合法整数就当没有
function parseEpisodeParam(raw: string | null): number | null {
  if (raw === null || !/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

function PlayPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<
    'searching' | 'preferring' | 'fetching' | 'ready'
  >('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在加载');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);

  // 收藏状态
  const [favorited, setFavorited] = useState(false);

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<{
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);

  // 去广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 字幕开关（从 localStorage 继承，默认 false）
  const [subtitleEnabled, setSubtitleEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_subtitle');
      if (v !== null) return v === 'true';
    }
    return false;
  });
  const subtitleEnabledRef = useRef(subtitleEnabled);
  useEffect(() => {
    subtitleEnabledRef.current = subtitleEnabled;
  }, [subtitleEnabled]);

  // AI 字幕开关（从 localStorage 继承，默认 false）
  const [aiSubtitleEnabled, setAiSubtitleEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_ai_subtitle');
      if (v !== null) return v === 'true';
    }
    return false;
  });

  // 当前播放时间（用于 AI 字幕同步）

  // 当前视频 URL（用于 AI 字幕）
  const [currentVideoUrl, setCurrentVideoUrl] = useState('');

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  // 当前源和ID
  const [currentSource, setCurrentSource] = useState(
    searchParams.get('source') || ''
  );
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');

  // 集数相关；链接带了 ep（扫码、投屏）就从那一集开始
  const [pinnedEpisode] = useState(() =>
    parseEpisodeParam(searchParams.get('ep'))
  );
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(
    pinnedEpisode ?? 0
  );

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);

  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  // 视频播放地址
  const [videoUrl, setVideoUrl] = useState('');

  // 总集数
  const totalEpisodes = detail?.episodes?.length || 0;

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef<number | null>(null);
  // 上次使用的音量，默认 0.7
  const lastVolumeRef = useRef<number>(0.7);
  // 上次使用的播放速率，默认 1.0
  const lastPlaybackRateRef = useRef<number>(1.0);

  // 换源相关状态
  const [availableSources, setAvailableSources] = useState<SearchResult[]>([]);
  const [sourceSearchLoading, setSourceSearchLoading] = useState(false);
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(
    null
  );

  // 折叠状态（仅在 lg 及以上屏幕有效）
  const [isEpisodeSelectorCollapsed, setIsEpisodeSelectorCollapsed] =
    useState(false);

  // 电视投屏弹窗状态
  const [isTVCastModalOpen, setIsTVCastModalOpen] = useState(false);

  // 换源加载状态
  const [isVideoLoading, setIsVideoLoading] = useState(true);
  const [videoLoadingStage, setVideoLoadingStage] = useState<
    'initing' | 'sourceChanging' | 'stalled'
  >('initing');
  // 加载超时或中途断流时，蒙层上显示的提示
  const [loadingHint, setLoadingHint] = useState('');

  // 起播或换线后 15 秒还没出画，改成"换一条线路"的提示，不让蒙层永远挡住控制栏
  useEffect(() => {
    if (!isVideoLoading) return;
    const timer = window.setTimeout(() => {
      setLoadingHint('线路加载较慢，可以换一条线路');
      setVideoLoadingStage('stalled');
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [isVideoLoading, videoUrl]);

  // 出错后把还在跑的播放器和 hls 拆掉，避免错误卡片下面还在出声
  useEffect(() => {
    if (!error) return;
    const player = artPlayerRef.current;
    if (!player) return;
    player.video?.hls?.destroy();
    wakeLockRef.current?.disable();
    player.destroy();
    artPlayerRef.current = null;
  }, [error]);

  // 片源确定后提前与 CDN 建立连接，省掉首个清单请求的 DNS 与 TLS 时间
  useEffect(() => {
    if (!videoUrl || typeof document === 'undefined') return;
    let origin = '';
    try {
      origin = new URL(videoUrl).origin;
    } catch {
      return;
    }
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = origin;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
    return () => link.remove();
  }, [videoUrl]);

  // 播放进度保存相关
  const saveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSaveTimeRef = useRef<number>(0);

  const artPlayerRef = useRef<any>(null);
  // 离开页面时 DOM ref 已经空了，播放中的节点要另外留住。
  const playingNodeRef = useRef<HTMLVideoElement | null>(null);
  const artRef = useRef<HTMLDivElement | null>(null);
  const autoNextRef = useRef(true);
  // 睡眠定时：off / 15 / 30 / 60（分钟）/ episode（本集结束）
  const sleepTimerRef = useRef<number>(0);
  const sleepEndOfEpisodeRef = useRef(false);
  // 当前选中的睡眠定时，播放器重建后菜单要回到这个选项
  const sleepChoiceRef = useRef('off');
  const wakeLockRef = useRef<ScreenWakeLock | null>(null);
  if (wakeLockRef.current === null && typeof window !== 'undefined') {
    wakeLockRef.current = createScreenWakeLock();
  }

  // 设置睡眠定时。定时到了暂停播放；「本集结束」由播放结束事件处理。
  const applySleepTimer = (choice: string) => {
    sleepChoiceRef.current = choice;
    if (sleepTimerRef.current) {
      window.clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = 0;
    }
    sleepEndOfEpisodeRef.current = choice === 'episode';
    const minutes = Number(choice);
    if (Number.isFinite(minutes) && minutes > 0) {
      sleepTimerRef.current = window.setTimeout(() => {
        sleepTimerRef.current = 0;
        sleepChoiceRef.current = 'off';
        // 离开页面后画中画里的视频也要能被暂停，所以两边都试
        const player = artPlayerRef.current;
        const video =
          (player && player.video) || document.pictureInPictureElement;
        if (video) (video as HTMLVideoElement).pause();
        if (player) player.notice.show = '睡眠定时已到，已暂停播放';
      }, minutes * 60 * 1000);
    }
  };

  useEffect(() => {
    return () => {
      // 画中画还在播时保留定时器，它会暂停画中画里的视频
      if (sleepTimerRef.current && !document.pictureInPictureElement) {
        window.clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = 0;
      }
      wakeLockRef.current?.disable();
    };
  }, []);
  const availableSourcesRef = useRef<SearchResult[]>([]);
  const failedSourceKeysRef = useRef<Set<string>>(new Set());
  const sourceSwitchingRef = useRef(false);
  // 地址里已经带了源，或用户点过线路，就停在这一条，不再自动跳到排序第一的源。
  const userChoseRef = useRef(false);
  const failOverRef = useRef<() => void>(() => undefined);
  const handleSourceChangeRef = useRef<
    (source: string, id: string, title: string) => void
  >(() => undefined);
  availableSourcesRef.current = availableSources;

  // -----------------------------------------------------------------------------
  // 工具函数（Utils）
  // -----------------------------------------------------------------------------

  // 按上游顺序起播。有直链 m3u8 的优先，分享页经常打不开。不下载正片。
  const pickOrderedSource = (sources: SearchResult[]): SearchResult => {
    const ranked = [...sources].sort(
      (a, b) => (a.source_rank ?? 999) - (b.source_rank ?? 999)
    );
    const withEpisodes = ranked.filter(
      (source) => source.episodes && source.episodes.length > 0
    );
    return (
      withEpisodes.find((source) =>
        source.episodes.some((episode) => episode.includes('.m3u8'))
      ) ||
      withEpisodes[0] ||
      ranked[0] ||
      sources[0]
    );
  };

  // 更新视频地址
  const updateVideoUrl = (
    detailData: SearchResult | null,
    episodeIndex: number
  ) => {
    if (
      !detailData ||
      !detailData.episodes ||
      episodeIndex >= detailData.episodes.length
    ) {
      setVideoUrl('');
      return;
    }
    const newUrl = detailData?.episodes[episodeIndex] || '';
    if (newUrl === videoUrl) {
      // 同一条地址已经在播，不会再触发 canplay，这里直接收起加载蒙层
      if (newUrl) setIsVideoLoading(false);
      return;
    }
    setVideoUrl(newUrl);
  };

  // AirPlay 要的是唯一的原生 HLS 地址；hls.js 的 MSE（blob）地址投不出去，所以切到原始 m3u8。
  // 切换记在 airPlaySwitchRef 里：同一个播放器只切一次；切换失败或投屏弹窗关闭时，据此把 hls.js 接回来（保留去广告）。
  type AirPlaySwitch = {
    art: NonNullable<typeof artPlayerRef.current>;
    video: HTMLVideoElement;
    url: string;
    at: number;
    resume: boolean;
    done: Promise<boolean>;
  };
  const airPlaySwitchRef = useRef<AirPlaySwitch | null>(null);

  // 把 hls.js 重新挂到这个 video 上，并回到切换前的进度
  const reattachHls = (
    art: NonNullable<typeof artPlayerRef.current>,
    video: HTMLVideoElement,
    url: string,
    at: number,
    resume: boolean
  ) => {
    video.removeAttribute('src');
    video.load();
    art.option.customType?.m3u8?.(video, url, art);
    if (at > 0) {
      video.addEventListener(
        'loadedmetadata',
        () => {
          video.currentTime = at;
          if (resume) void video.play().catch(() => undefined);
        },
        { once: true }
      );
    }
  };

  const prepareAirPlay = async (): Promise<boolean> => {
    const art = artPlayerRef.current;
    const video = art?.video as
      | (HTMLVideoElement & { hls?: { destroy: () => void } })
      | undefined;
    if (!art || !video || !videoUrl || !supportsNativeHls(video)) {
      return Promise.resolve(false);
    }
    const switched = airPlaySwitchRef.current;
    if (switched && switched.art === art && switched.video === video) {
      return switched.done;
    }
    // 本来就是原生播放（mp4），不需要切换
    if (!video.hls) return Promise.resolve(true);
    // 黄果清单是站内入口。电视要在这一刻拿到新的绝对地址，旧签名过几秒就失效。
    const nativeUrl = parseHuangguoPlaylist(videoUrl)
      ? (await freshHuangguoDirectUrl(videoUrl)) || videoUrl
      : videoUrl;
    if (artPlayerRef.current !== art || !video.isConnected) return false;
    // 销毁 hls.js 会清空进度和播放状态，所以先记下
    const at = video.currentTime;
    const resume = !video.paused;
    video.__ckTeardown?.();
    video.hls.destroy();
    video.hls = undefined;
    video.disableRemotePlayback = false;
    const done = loadNativeSource(video, nativeUrl, { at, resume }).then(
      (ok) => {
        if (ok) return true;
        airPlaySwitchRef.current = null;
        // 播放器已经换了（换集、离开页面）时，旧 video 已经脱离，不能再挂 hls.js
        if (artPlayerRef.current === art && video.isConnected) {
          reattachHls(art, video, videoUrl, at, resume);
        }
        return false;
      }
    );
    airPlaySwitchRef.current = {
      art,
      video,
      url: videoUrl,
      at,
      resume,
      done,
    };
    return done;
  };

  // 投屏弹窗关闭、且没有投到 AirPlay 设备时，把本机播放切回 hls.js，去广告才会恢复
  const restoreLocalHls = () => {
    const switched = airPlaySwitchRef.current;
    if (!switched) return;
    const { art, video, url } = switched;
    if (artPlayerRef.current !== art || !video.isConnected) {
      airPlaySwitchRef.current = null;
      return;
    }
    // 正在投到 AirPlay 设备：保留原生地址，否则会断开投屏
    if (isAirPlaying(video)) return;
    airPlaySwitchRef.current = null;
    reattachHls(art, video, url, video.currentTime, !video.paused);
  };

  // 跳过片头片尾配置相关函数
  const handleSkipConfigChange = async (newConfig: {
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }) => {
    if (!currentSourceRef.current || !currentIdRef.current) return;

    try {
      setSkipConfig(newConfig);
      if (!newConfig.enable && !newConfig.intro_time && !newConfig.outro_time) {
        await deleteSkipConfig(currentSourceRef.current, currentIdRef.current);
        artPlayerRef.current.setting.update({
          name: '跳过片头片尾',
          html: '跳过片头片尾',
          switch: skipConfigRef.current.enable,
          onSwitch: function (item: any) {
            const newConfig = {
              ...skipConfigRef.current,
              enable: !item.switch,
            };
            handleSkipConfigChange(newConfig);
            return !item.switch;
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片头',
          html: '设置片头',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
          tooltip:
            skipConfigRef.current.intro_time === 0
              ? '设置片头时间'
              : `${formatTime(skipConfigRef.current.intro_time)}`,
          onClick: function () {
            const currentTime = artPlayerRef.current?.currentTime || 0;
            if (currentTime > 0) {
              const newConfig = {
                ...skipConfigRef.current,
                intro_time: currentTime,
              };
              handleSkipConfigChange(newConfig);
              return `${formatTime(currentTime)}`;
            }
          },
        });
        artPlayerRef.current.setting.update({
          name: '设置片尾',
          html: '设置片尾',
          icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
          tooltip:
            skipConfigRef.current.outro_time >= 0
              ? '设置片尾时间'
              : `-${formatTime(-skipConfigRef.current.outro_time)}`,
          onClick: function () {
            const outroTime =
              -(
                artPlayerRef.current?.duration -
                artPlayerRef.current?.currentTime
              ) || 0;
            if (outroTime < 0) {
              const newConfig = {
                ...skipConfigRef.current,
                outro_time: outroTime,
              };
              handleSkipConfigChange(newConfig);
              return `-${formatTime(-outroTime)}`;
            }
          },
        });
      } else {
        await saveSkipConfig(
          currentSourceRef.current,
          currentIdRef.current,
          newConfig
        );
      }
    } catch (err) {
      console.error('保存跳过片头片尾配置失败:', err);
    }
  };

  const formatTime = (seconds: number): string => {
    if (seconds === 0) return '00:00';

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.round(seconds % 60);

    if (hours === 0) {
      // 不到一小时，格式为 00:00
      return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
        .toString()
        .padStart(2, '0')}`;
    } else {
      // 超过一小时，格式为 00:00:00
      return `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
  };

  class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, config: any, callbacks: any) {
        // 拦截manifest和level请求
        if (
          (context as any).type === 'manifest' ||
          (context as any).type === 'level'
        ) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (
            response: any,
            stats: any,
            context: any
          ) {
            // 如果是m3u8文件，处理内容以移除广告分段
            if (response.data && typeof response.data === 'string') {
              // 过滤掉广告段 - 实现更精确的广告过滤逻辑
              // 用重定向之后的地址解析相对片段，和 hls.js 的解析保持一致
              const filtered = filterAdBreaks(
                response.data,
                response.url || context?.url
              );
              response.data = filtered.text;
              // 过滤生效时给出提示，让用户看得见跳过了什么
              if (filtered.removedSegments > 0 && artPlayerRef.current) {
                const seconds = Math.round(filtered.removedSeconds);
                artPlayerRef.current.notice.show = `已跳过插播约 ${seconds} 秒`;
              }
            }
            return onSuccess(response, stats, context, null);
          };
        }
        // 执行原始load方法
        load(context, config, callbacks);
      };
    }
  }

  // 当集数索引变化时自动更新视频地址
  useEffect(() => {
    updateVideoUrl(detail, currentEpisodeIndex);
  }, [detail, currentEpisodeIndex]);

  // 进入页面时直接获取全部源信息
  useEffect(() => {
    let blocked = false;
    const fetchSourceDetail = async (
      source: string,
      id: string
    ): Promise<SearchResult[]> => {
      try {
        const detailResponse = await fetch(
          `/api/detail?source=${source}&id=${id}&v=${DETAIL_CACHE_VERSION}${
            source === 'huangguo' ? '&hv=2' : ''
          }`
        );
        if (detailResponse.status === 403) {
          blocked = true;
          return [];
        }
        if (!detailResponse.ok) {
          throw new Error('获取视频详情失败');
        }
        const detailData = (await detailResponse.json()) as SearchResult;
        setAvailableSources([detailData]);
        return [detailData];
      } catch (err) {
        console.error('获取视频详情失败:', err);
        return [];
      } finally {
        setSourceSearchLoading(false);
      }
    };
    const fetchSourcesData = async (
      query: string,
      background = false
    ): Promise<SearchResult[]> => {
      // 根据搜索词获取全部源信息
      try {
        const searchUrl = `/api/search?q=${encodeURIComponent(
          query.trim()
        )}&v=${SEARCH_CACHE_VERSION}`;
        const response = await fetch(searchUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('搜索失败');
        }
        const data = await response.json();
        const wantedTitle = query.trim() || videoTitleRef.current;
        const matchList = (list: SearchResult[]) =>
          pickPlayable(
            list || [],
            wantedTitle,
            videoYearRef.current,
            searchType
          );
        let results = matchList(data.results);
        const partial = response.headers.get('x-ck-cache') === 'PARTIAL';
        // 首批源还没凑齐时先等一次完整结果，避免页面先报没找到。
        if (partial && results.length === 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 1600));
          try {
            const again = await fetch(searchUrl, { cache: 'no-store' });
            if (again.ok) {
              const againData = await again.json();
              const more = matchList(againData.results);
              if (more.length > 0) results = more;
            }
          } catch {
            // 补搜失败时沿用第一批
          }
        } else if (partial) {
          // 首包是快的那几条。完整片源写进缓存还要几秒，这里最多再拉两次。
          const mergeLater = (delay: number) => {
            window.setTimeout(async () => {
              try {
                const again = await fetch(searchUrl, { cache: 'no-store' });
                if (!again.ok) return;
                const againData = await again.json();
                const more = matchList(againData.results);
                if (shouldReplaceListing(results, more)) {
                  results = more;
                  setAvailableSources((current) => {
                    const seen = new Set(
                      more.map(
                        (item: SearchResult) => `${item.source}:${item.id}`
                      )
                    );
                    const kept = current.filter(
                      (item) => !seen.has(`${item.source}:${item.id}`)
                    );
                    return [...more, ...kept];
                  });
                }
                if (
                  again.headers.get('x-ck-cache') === 'PARTIAL' &&
                  delay < 4000
                ) {
                  mergeLater(delay + 2200);
                }
              } catch {
                // 线路补全失败时继续用已经开播的源
              }
            }, delay);
          };
          mergeLater(1800);
        }
        if (!background) setAvailableSources(results);
        return results;
      } catch (err) {
        if (!background) {
          setSourceSearchError(err instanceof Error ? err.message : '搜索失败');
          setAvailableSources([]);
        }
        return [];
      } finally {
        if (!background) setSourceSearchLoading(false);
      }
    };

    const initAll = async () => {
      if (!currentSource && !currentId && !videoTitle && !searchTitle) {
        setError('缺少必要参数');
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadingStage(currentSource && currentId ? 'fetching' : 'searching');
      setLoadingMessage('正在加载');

      // 已经点了具体片源时，先拉这一条详情就开播，其它线路在后台补。
      // prefer 只补同一部的其它线路，不把点中的源换成排序靠前的另一条。
      let sourcesInfo: SearchResult[] = [];
      if (currentSource && currentId) {
        userChoseRef.current = true;
        const quick = await fetchSourceDetail(currentSource, currentId);
        if (blocked) {
          setError('禁止国内访问。中国大陆、香港、澳门、台湾不能进入。');
          setLoading(false);
          return;
        }
        const quickDetail = quick[0];
        if (quickDetail?.episodes?.length) {
          sourcesInfo = [quickDetail];
          // 黄果不拿片名去全站搜索。同名结果会把选集换成另一部，切来切去还是那一条。
          if (currentSource !== 'huangguo') {
            void fetchSourcesData(videoTitle || searchTitle, true).then(
              (results) => {
                if (results.length === 0) return;
                const hasCurrent = results.some(
                  (source) =>
                    String(source.source) === String(currentSource) &&
                    String(source.id) === String(currentId)
                );
                setAvailableSources(
                  hasCurrent ? results : [quickDetail, ...results]
                );
              }
            );
          }
        } else if (currentSource === 'huangguo') {
          setError('片库里暂时没有这一部');
          setLoading(false);
          return;
        }
      }
      if (sourcesInfo.length === 0) {
        sourcesInfo = await fetchSourcesData(videoTitle || searchTitle);
      }
      if (sourcesInfo.length === 0) {
        setError('片库里暂时没有这一部');
        setLoading(false);
        return;
      }

      let detailData: SearchResult = sourcesInfo[0];
      const pinned =
        currentSource && currentId
          ? sourcesInfo.find(
              (source) =>
                String(source.source) === String(currentSource) &&
                String(source.id) === String(currentId) &&
                source.episodes?.length
            )
          : undefined;
      // 点中的源能播就用它。没有指定源时才按线路顺序起播。
      detailData = pinned || pickOrderedSource(sourcesInfo);

      setCurrentSource(detailData.source);
      setCurrentId(detailData.id);
      setVideoYear(detailData.year);
      setVideoTitle(repairTitle(detailData.title || videoTitleRef.current));
      setVideoCover(detailData.poster);
      setDetail(detailData);
      if (currentEpisodeIndex >= detailData.episodes.length) {
        setCurrentEpisodeIndex(0);
      }

      // 规范URL参数
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', detailData.source);
      newUrl.searchParams.set('id', detailData.id);
      newUrl.searchParams.set('year', detailData.year);
      newUrl.searchParams.set('title', detailData.title);
      newUrl.searchParams.delete('prefer');
      // ep 只在打开链接时起作用；留着的话刷新会退回到链接里的那一集
      newUrl.searchParams.delete('ep');
      window.history.replaceState({}, '', newUrl.toString());

      setLoadingStage('ready');
      setLoading(false);
    };

    initAll();
  }, []);

  // 播放记录处理
  useEffect(() => {
    // 仅在初次挂载时检查播放记录
    const initFromHistory = async () => {
      if (!currentSource || !currentId) return;

      try {
        const allRecords = await getAllPlayRecords();
        const key = generateStorageKey(currentSource, currentId);
        const record = allRecords[key];

        if (record) {
          const targetIndex = record.index - 1;
          const targetTime = record.play_time;

          // 链接指定了集数时以链接为准，进度只有属于这一集才恢复
          if (pinnedEpisode !== null && pinnedEpisode !== targetIndex) return;

          // 更新当前选集索引
          if (targetIndex !== currentEpisodeIndex) {
            setCurrentEpisodeIndex(targetIndex);
          }

          // 保存待恢复的播放进度，待播放器就绪后跳转
          resumeTimeRef.current = targetTime;
        }
      } catch (err) {
        console.error('读取播放记录失败:', err);
      }
    };

    initFromHistory();
  }, []);

  // 跳过片头片尾配置处理
  useEffect(() => {
    // 仅在初次挂载时检查跳过片头片尾配置
    const initSkipConfig = async () => {
      if (!currentSource || !currentId) return;

      try {
        const config = await getSkipConfig(currentSource, currentId);
        if (config) {
          setSkipConfig(config);
        }
      } catch (err) {
        console.error('读取跳过片头片尾配置失败:', err);
      }
    };

    initSkipConfig();
  }, []);

  // 处理换源
  const handleSourceChange = async (
    newSource: string,
    newId: string,
    newTitle: string
  ) => {
    userChoseRef.current = true;
    try {
      // 显示换源加载状态
      setVideoLoadingStage('sourceChanging');
      setIsVideoLoading(true);

      // 记录当前播放进度（仅在同一集数切换时恢复）
      const currentPlayTime = artPlayerRef.current?.currentTime || 0;

      // 清除前一个历史记录
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deletePlayRecord(
            currentSourceRef.current,
            currentIdRef.current
          );
        } catch (err) {
          console.error('清除播放记录失败:', err);
        }
      }

      // 清除并设置下一个跳过片头片尾配置
      if (currentSourceRef.current && currentIdRef.current) {
        try {
          await deleteSkipConfig(
            currentSourceRef.current,
            currentIdRef.current
          );
          await saveSkipConfig(newSource, newId, skipConfigRef.current);
        } catch (err) {
          console.error('清除跳过片头片尾配置失败:', err);
        }
      }

      const newDetail = availableSources.find(
        (source) =>
          String(source.source) === String(newSource) &&
          String(source.id) === String(newId)
      );
      if (!newDetail) {
        setIsVideoLoading(false);
        setError('未找到匹配结果');
        return;
      }

      // 尝试跳转到当前正在播放的集数
      let targetIndex = currentEpisodeIndex;

      // 如果当前集数超出新源的范围，则跳转到第一集
      if (!newDetail.episodes || targetIndex >= newDetail.episodes.length) {
        targetIndex = 0;
      }

      // 如果仍然是同一集数且播放进度有效，则在播放器就绪后恢复到原始进度
      if (targetIndex !== currentEpisodeIndex) {
        resumeTimeRef.current = 0;
      } else if (
        (!resumeTimeRef.current || resumeTimeRef.current === 0) &&
        currentPlayTime > 1
      ) {
        resumeTimeRef.current = currentPlayTime;
      }

      // 更新URL参数（不刷新页面）
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.set('source', newSource);
      newUrl.searchParams.set('id', newId);
      newUrl.searchParams.set('year', newDetail.year);
      window.history.replaceState({}, '', newUrl.toString());

      setVideoTitle(repairTitle(newDetail.title || newTitle));
      setVideoYear(newDetail.year);
      setVideoCover(newDetail.poster);
      setCurrentSource(newSource);
      setCurrentId(newId);
      setDetail(newDetail);
      setCurrentEpisodeIndex(targetIndex);
    } catch (err) {
      // 隐藏换源加载状态
      setIsVideoLoading(false);
      setError(err instanceof Error ? err.message : '换源失败');
    }
  };
  handleSourceChangeRef.current = handleSourceChange;
  // 挑下一条可用线路：有 m3u8、没有失败过、排名最靠前
  const pickNextSource = () =>
    [...availableSourcesRef.current]
      .filter((source) =>
        source.episodes?.some((episode) => episode.includes('.m3u8'))
      )
      .filter(
        (source) =>
          !failedSourceKeysRef.current.has(`${source.source}:${source.id}`)
      )
      .sort((a, b) => (a.source_rank ?? 999) - (b.source_rank ?? 999))[0];

  // 用户点"换一条线路"：不受 userChoseRef 限制，直接切到下一条
  const switchLineManually = () => {
    const currentKey = `${currentSourceRef.current}:${currentIdRef.current}`;
    failedSourceKeysRef.current.add(currentKey);
    const next = pickNextSource();
    if (!next) return;
    sourceSwitchingRef.current = true;
    handleSourceChangeRef.current(next.source, next.id, next.title);
  };

  failOverRef.current = () => {
    if (userChoseRef.current) return;
    if (sourceSwitchingRef.current) return;
    if ((artPlayerRef.current?.currentTime || 0) > 1) return;
    const currentKey = `${currentSourceRef.current}:${currentIdRef.current}`;
    failedSourceKeysRef.current.add(currentKey);
    const next = pickNextSource();
    if (!next) return;
    sourceSwitchingRef.current = true;
    handleSourceChangeRef.current(next.source, next.id, next.title);
  };

  useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => {
      document.removeEventListener('keydown', handleKeyboardShortcuts);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 集数切换
  // ---------------------------------------------------------------------------
  // 处理集数切换
  const handleEpisodeChange = (episodeNumber: number) => {
    if (episodeNumber >= 0 && episodeNumber < totalEpisodes) {
      // 在更换集数前保存当前播放进度（播放中或暂停中都要存）
      saveCurrentPlayProgress();
      setCurrentEpisodeIndex(episodeNumber);
    }
  };

  const handlePreviousEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx > 0) {
      saveCurrentPlayProgress();
      setCurrentEpisodeIndex(idx - 1);
    }
  };

  const handleNextEpisode = () => {
    const d = detailRef.current;
    const idx = currentEpisodeIndexRef.current;
    if (d && d.episodes && idx < d.episodes.length - 1) {
      saveCurrentPlayProgress();
      setCurrentEpisodeIndex(idx + 1);
    }
  };

  // ---------------------------------------------------------------------------
  // 键盘快捷键
  // ---------------------------------------------------------------------------
  // 处理全局快捷键
  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // 忽略输入框、可编辑区域，以及 Ctrl/Cmd 组合键（比如 Ctrl+F 查找）
    if (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable ||
      e.ctrlKey ||
      e.metaKey
    )
      return;
    const focusOnControl =
      target.tagName === 'BUTTON' || target.tagName === 'A';

    // Alt + 左箭头 = 上一集
    if (e.altKey && e.key === 'ArrowLeft') {
      if (detailRef.current && currentEpisodeIndexRef.current > 0) {
        handlePreviousEpisode();
        e.preventDefault();
      }
    }

    // Alt + 右箭头 = 下一集
    if (e.altKey && e.key === 'ArrowRight') {
      const d = detailRef.current;
      const idx = currentEpisodeIndexRef.current;
      if (d && idx < d.episodes.length - 1) {
        handleNextEpisode();
        e.preventDefault();
      }
    }

    // 左箭头 = 快退
    if (!e.altKey && e.key === 'ArrowLeft') {
      if (artPlayerRef.current && artPlayerRef.current.currentTime > 5) {
        artPlayerRef.current.currentTime -= 10;
        e.preventDefault();
      }
    }

    // 右箭头 = 快进
    if (!e.altKey && e.key === 'ArrowRight') {
      if (
        artPlayerRef.current &&
        artPlayerRef.current.currentTime < artPlayerRef.current.duration - 5
      ) {
        artPlayerRef.current.currentTime += 10;
        e.preventDefault();
      }
    }

    // 上箭头 = 音量+
    if (e.key === 'ArrowUp') {
      if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 下箭头 = 音量-
    if (e.key === 'ArrowDown') {
      if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
        artPlayerRef.current.volume =
          Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
        artPlayerRef.current.notice.show = `音量: ${Math.round(
          artPlayerRef.current.volume * 100
        )}`;
        e.preventDefault();
      }
    }

    // 空格 = 播放/暂停（焦点在按钮或链接上时交给元素本身）
    if (e.key === ' ' && !focusOnControl) {
      if (artPlayerRef.current) {
        artPlayerRef.current.toggle();
        e.preventDefault();
      }
    }

    // f 键 = 切换全屏
    if (e.key === 'f' || e.key === 'F') {
      if (artPlayerRef.current) {
        artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
        e.preventDefault();
      }
    }
  };

  // ---------------------------------------------------------------------------
  // 播放记录相关
  // ---------------------------------------------------------------------------
  // 保存播放进度
  const saveCurrentPlayProgress = async () => {
    if (
      !artPlayerRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current ||
      !videoTitleRef.current ||
      !detailRef.current?.source_name
    ) {
      return;
    }

    const player = artPlayerRef.current;
    const currentTime = player.currentTime || 0;
    const duration = player.duration || 0;

    // 如果播放时间太短（少于5秒）或者视频时长无效，不保存
    if (currentTime < 1 || !duration) {
      return;
    }

    try {
      await savePlayRecord(currentSourceRef.current, currentIdRef.current, {
        title: videoTitleRef.current,
        source_name: detailRef.current?.source_name || '',
        year: detailRef.current?.year,
        cover: detailRef.current?.poster || '',
        index: currentEpisodeIndexRef.current + 1, // 转换为1基索引
        total_episodes: detailRef.current?.episodes.length || 1,
        play_time: Math.floor(currentTime),
        total_time: Math.floor(duration),
        save_time: Date.now(),
        search_title: searchTitle,
      });

      lastSaveTimeRef.current = Date.now();
    } catch (err) {
      console.error('保存播放进度失败:', err);
    }
  };

  useEffect(() => {
    // 页面即将卸载时保存播放进度
    const handleBeforeUnload = () => {
      saveCurrentPlayProgress();
    };

    // 页面可见性变化时保存播放进度
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentPlayProgress();
      }
    };

    // 添加事件监听器
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      // 清理事件监听器
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentEpisodeIndex, detail, artPlayerRef.current]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 收藏相关
  // ---------------------------------------------------------------------------
  // 每当 source 或 id 变化时检查收藏状态
  useEffect(() => {
    if (!currentSource || !currentId) return;
    (async () => {
      try {
        const fav = await isFavorited(currentSource, currentId);
        setFavorited(fav);
      } catch (err) {
        console.error('检查收藏状态失败:', err);
      }
    })();
  }, [currentSource, currentId]);

  // 监听收藏数据更新事件
  useEffect(() => {
    if (!currentSource || !currentId) return;

    const unsubscribe = subscribeToDataUpdates(
      'favoritesUpdated',
      (favorites: Record<string, any>) => {
        const key = generateStorageKey(currentSource, currentId);
        const isFav = !!favorites[key];
        setFavorited(isFav);
      }
    );

    return unsubscribe;
  }, [currentSource, currentId]);

  // 切换收藏
  const handleToggleFavorite = async () => {
    if (
      !videoTitleRef.current ||
      !detailRef.current ||
      !currentSourceRef.current ||
      !currentIdRef.current
    )
      return;

    try {
      if (favorited) {
        // 如果已收藏，删除收藏
        await deleteFavorite(currentSourceRef.current, currentIdRef.current);
        setFavorited(false);
      } else {
        // 如果未收藏，添加收藏
        await saveFavorite(currentSourceRef.current, currentIdRef.current, {
          title: videoTitleRef.current,
          source_name: detailRef.current?.source_name || '',
          year: detailRef.current?.year,
          cover: detailRef.current?.poster || '',
          total_episodes: detailRef.current?.episodes.length || 1,
          save_time: Date.now(),
          search_title: searchTitle,
        });
        setFavorited(true);
      }
    } catch (err) {
      console.error('切换收藏失败:', err);
    }
  };

  useEffect(() => {
    if (
      !Artplayer ||
      !Hls ||
      !videoUrl ||
      loading ||
      currentEpisodeIndex === null ||
      !artRef.current
    ) {
      return;
    }

    // 确保选集索引有效
    if (
      !detail ||
      !detail.episodes ||
      currentEpisodeIndex >= detail.episodes.length ||
      currentEpisodeIndex < 0
    ) {
      setError(`选集索引无效，当前共 ${totalEpisodes} 集`);
      return;
    }

    if (!videoUrl) {
      setError('视频地址无效');
      return;
    }
    // 新地址已经交到播放器，允许下一次起播失败再换线。
    sourceSwitchingRef.current = false;

    // 检测是否为WebKit浏览器
    const isWebkit =
      typeof window !== 'undefined' &&
      typeof (window as any).webkitConvertPointFromNodeToPage === 'function';

    // 非 WebKit 不走 switch。播放器把地址记在 option.url，拆掉旧 hls 触发的 error 会按它重连。
    // 不先改成这一集的话，重连目标一直是第一集，后面点哪集都是同一段画面。
    if (!isWebkit && artPlayerRef.current) {
      const art = artPlayerRef.current;
      const video = art.video as HTMLVideoElement & {
        hls?: { destroy: () => void };
        __ckTeardown?: () => void;
      };
      art.option.url = videoUrl;
      if (video?.hls) {
        video.__ckTeardown?.();
        video.hls.destroy();
        video.hls = undefined;
      }
      try {
        video.pause();
        if (video.currentTime > 0) video.currentTime = 0;
      } catch {
        // 旧媒体已经拆掉时改进度会抛错，下一集照样拉。
      }
      art.option.customType?.m3u8?.(video, videoUrl, art);
      art.title = `${videoTitle} - 第${currentEpisodeIndex + 1}集`;
      art.poster = processImageUrl(videoCover);
      return;
    }

    // WebKit浏览器或首次创建：销毁之前的播放器实例并创建新的
    if (artPlayerRef.current) {
      if (artPlayerRef.current.video && artPlayerRef.current.video.hls) {
        artPlayerRef.current.video.hls.destroy();
      }
      // 销毁播放器实例
      wakeLockRef.current?.disable();
      artPlayerRef.current.destroy();
      artPlayerRef.current = null;
    }

    try {
      // 创建新的播放器实例
      // 音量和自动连播沿用上次的设置；音量要同步给恢复逻辑，否则会被换回默认值
      const savedVolume = readVolume();
      lastVolumeRef.current = savedVolume;
      autoNextRef.current = readAutoNext();
      // 控制栏开关和设置里的「自动连播」共用这一项。开：本集结束就进下一集。关：停在当前这一集。
      let autoNextButton: HTMLElement | null = null;
      const autoNextSetting: any = {
        switch: autoNextRef.current,
        onSwitch(item: any) {
          const enabled = !item.switch;
          applyAutoNext(enabled);
          return enabled;
        },
      };
      const paintAutoNext = (enabled: boolean) => {
        if (!autoNextButton) return;
        autoNextButton.dataset.on = enabled ? '1' : '0';
        autoNextButton.style.color = enabled
          ? '#16a34a'
          : 'rgba(255,255,255,0.55)';
        autoNextButton.textContent = enabled ? '连播开' : '连播关';
      };
      const applyAutoNext = (enabled: boolean) => {
        autoNextRef.current = enabled;
        writeAutoNext(enabled);
        autoNextSetting.switch = enabled;
        // 控制栏切换时也要把菜单里的「自动连播」图标改过来；菜单项是 ArtPlayer 持有的对象，要改它本身
        const menuItem = artPlayerRef.current?.setting?.find('自动连播');
        if (menuItem) menuItem.switch = enabled;
        paintAutoNext(enabled);
      };
      Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
      Artplayer.USE_RAF = true;

      artPlayerRef.current = new Artplayer({
        container: artRef.current,
        url: videoUrl,
        poster: processImageUrl(videoCover),
        volume: savedVolume,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: false,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        // AirPlay 统一走投屏弹窗：先切到原生 HLS 地址再调出选择器。播放器自带的按钮会跳过这一步
        airplay: false,
        theme: '#22c55e',
        lang: 'zh-cn',
        hotkey: false,
        fastForward: true,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: 'anonymous',
        },
        // 字幕配置（支持内嵌字幕和外挂字幕）
        subtitle: {
          style: {
            color: '#FFFFFF',
            fontSize: '24px',
            fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif',
            textShadow: '2px 2px 4px rgba(0, 0, 0, 0.8)',
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            padding: '4px 8px',
            borderRadius: '4px',
          },
        },
        // HLS 支持配置
        customType: {
          m3u8: function (video: HTMLVideoElement, url: string) {
            if (!Hls) {
              console.error('HLS.js 未加载');
              return;
            }

            // 同一个 <video> 会被复用，先拆掉上一轮挂的监听和定时器，避免越切越多
            video.__ckTeardown?.();
            if (video.hls) {
              video.hls.destroy();
            }
            const hls = new Hls({
              debug: false,
              enableWorker: true,
              lowLatencyMode: false,
              capLevelToPlayerSize: true,
              startLevel: -1,
              // 新的一集从 0 开始。不写的话，上一集留在 video 上的进度会被当成这一集的起点。
              startPosition: 0,
              // 先按约 900kbps 起播，缓冲上来再升档，避免一上来选 1080p 把线路打满
              abrEwmaDefaultEstimate: 900_000,
              abrBandWidthFactor: 0.85,
              abrBandWidthUpFactor: 0.7,

              /* 先攒够可播缓冲，再限制上限，避免手机硬解 4K 把线路打满 */
              // 30 秒缓冲能扛住线路抖动。maxBufferSize 与码率一起决定缓冲目标长度，并不是内存上限。
              maxBufferLength: 30,
              maxMaxBufferLength: 60,
              backBufferLength: 8,
              maxBufferSize: 24 * 1000 * 1000,
              // 首片与 MSE 初始化并行拉取，起播少等一个往返
              startFragPrefetch: true,

              maxBufferHole: 0.5,
              highBufferWatchdogPeriod: 2,
              nudgeOffset: 0.1,
              nudgeMaxRetry: 3,

              manifestLoadingTimeOut: 12000,
              manifestLoadingMaxRetry: 2,
              levelLoadingTimeOut: 12000,
              levelLoadingMaxRetry: 2,
              // 旧的 fragLoadingTimeOut 会把整段下载也限制在 8 秒，弱网下几 MB 的片段反复超时、画面卡顿。
              // 首字节 10 秒、整段 20 秒；超时和出错各重试 3 次，退避上限 8 秒。
              fragLoadPolicy: {
                default: {
                  maxTimeToFirstByteMs: 10_000,
                  maxLoadTimeMs: 20_000,
                  timeoutRetry: {
                    maxNumRetry: 3,
                    retryDelayMs: 1000,
                    maxRetryDelayMs: 8000,
                  },
                  errorRetry: {
                    maxNumRetry: 3,
                    retryDelayMs: 1000,
                    maxRetryDelayMs: 8000,
                  },
                },
              },
              // 不播放清单里的 DATERANGE 插播（X-ASSET-LIST 等）。这类广告不经过清单过滤，必须在 hls.js 层关掉。
              enableInterstitialPlayback: false,

              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });

            hls.loadSource(url);
            hls.attachMedia(video);
            video.hls = hls;

            let opened = false;
            let networkRetries = 0;
            let midStreamRetries = 0;
            // 只在卡住超过 1.2 秒、且后面已经有缓冲时轻轻前移，避免每次 waiting 都跳进度
            let stallTimer = 0;
            const clearStallTimer = () => {
              if (stallTimer) {
                window.clearTimeout(stallTimer);
                stallTimer = 0;
              }
            };
            const onPlaying = () => {
              opened = true;
              clearStallTimer();
            };
            const onWaiting = () => {
              if (stallTimer) return;
              stallTimer = window.setTimeout(() => {
                stallTimer = 0;
                if (video.readyState >= 3 || !video.buffered) return;
                const cur = video.currentTime;
                for (let i = 0; i < video.buffered.length; i++) {
                  const start = video.buffered.start(i);
                  const end = video.buffered.end(i);
                  if (start <= cur + 0.4 && end - cur > 1) {
                    video.currentTime = Math.min(cur + 0.2, end - 0.2);
                    break;
                  }
                }
              }, 1200);
            };
            video.addEventListener('playing', onPlaying);
            video.addEventListener('waiting', onWaiting);
            video.__ckTeardown = () => {
              video.removeEventListener('playing', onPlaying);
              video.removeEventListener('waiting', onWaiting);
              clearStallTimer();
            };

            // 片段成功加载说明线路恢复了，续播次数清零，所以上限只统计连续失败
            hls.on(Hls.Events.FRAG_LOADED, function () {
              midStreamRetries = 0;
            });

            hls.on(Hls.Events.ERROR, function (event: any, data: any) {
              if (!data?.fatal) return;
              // 这一轮还没出过画面。不能看 currentTime，上一集的进度还留在同一个 video 上。
              const notStarted = !opened;
              const manifestDead =
                data.details === 'manifestLoadError' ||
                data.details === 'manifestLoadTimeOut' ||
                data.details === 'manifestParsingError' ||
                data.details === 'levelLoadError';
              // 还没出画面时，清单打不开就换下一条。已经在播的只自救，不因测速换线。
              if (notStarted && manifestDead) {
                if (parseHuangguoPlaylist(url)) {
                  hls.destroy();
                  video.hls = undefined;
                  setLoadingHint('这一集没有打开，再点一次');
                  setVideoLoadingStage('stalled');
                  setIsVideoLoading(true);
                  return;
                }
                failOverRef.current();
                return;
              }
              // 还没出画面的网络错误：换线前只重试一次，并从 0 开始，避免续上一集的进度
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR && notStarted) {
                if (networkRetries >= 1) {
                  failOverRef.current();
                  return;
                }
                networkRetries += 1;
                hls.startLoad(0);
                return;
              }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
                return;
              }
              if (notStarted) {
                failOverRef.current();
                return;
              }
              // 已经在播：从当前位置续播几次，仍失败就停住并提示换线
              if (midStreamRetries < 3) {
                midStreamRetries += 1;
                hls.startLoad(video.currentTime || undefined);
                return;
              }
              hls.destroy();
              setLoadingHint('播放中断，可以换一条线路');
              setVideoLoadingStage('stalled');
              setIsVideoLoading(true);
            });
          },
        },
        icons: {
          loading:
            '<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MCIgaGVpZ2h0PSI1MCIgdmlld0JveD0iMCAwIDUwIDUwIj48cGF0aCBkPSJNMjUuMjUxIDYuNDYxYy0xMC4zMTggMC0xOC42ODMgOC4zNjUtMTguNjgzIDE4LjY4M2g0LjA2OGMwLTguMDcgNi41NDUtMTQuNjE1IDE0LjYxNS0xNC42MTVWNi40NjF6IiBmaWxsPSIjMDA5Njg4Ij48YW5pbWF0ZVRyYW5zZm9ybSBhdHRyaWJ1dGVOYW1lPSJ0cmFuc2Zvcm0iIGF0dHJpYnV0ZVR5cGU9IlhNTCIgZHVyPSIxcyIgZnJvbT0iMCAyNSAyNSIgcmVwZWF0Q291bnQ9ImluZGVmaW5pdGUiIHRvPSIzNjAgMjUgMjUiIHR5cGU9InJvdGF0ZSIvPjwvcGF0aD48L3N2Zz4=">',
        },
        settings: [
          {
            name: '显示字幕',
            html: '显示字幕',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="16" rx="2" stroke="#ffffff" stroke-width="2"/><path d="M6 15h3M11 15h7M6 11h5M13 11h5" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>',
            switch: subtitleEnabled,
            onSwitch: function (item: any) {
              const newVal = !item.switch;
              try {
                localStorage.setItem('enable_subtitle', String(newVal));
                setSubtitleEnabled(newVal);
                // 控制 Artplayer 字幕显示
                if (artPlayerRef.current && artPlayerRef.current.subtitle) {
                  artPlayerRef.current.subtitle.show = newVal;
                }
                // 同步更新设置面板的 switch 状态
                artPlayerRef.current?.setting?.update({
                  name: '显示字幕',
                  switch: newVal,
                });
              } catch (_) {
                // ignore
              }
              return newVal;
            },
          },
          {
            name: 'AI字幕',
            html: 'AI字幕',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="4" width="20" height="16" rx="2" stroke="#ffffff" stroke-width="2"/><text x="12" y="14" font-size="8" font-weight="bold" text-anchor="middle" fill="#ffffff">AI</text></svg>',
            switch: aiSubtitleEnabled,
            onSwitch: function (item: any) {
              const newVal = !item.switch;
              try {
                localStorage.setItem('enable_ai_subtitle', String(newVal));
                setAiSubtitleEnabled(newVal);
                // 同步更新设置面板的 switch 状态
                artPlayerRef.current?.setting?.update({
                  name: 'AI字幕',
                  switch: newVal,
                });
              } catch (_) {
                // ignore
              }
              return newVal;
            },
          },
          {
            html: '去广告',
            icon: '<text x="50%" y="50%" font-size="20" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="#ffffff">AD</text>',
            tooltip: blockAdEnabled ? '已开启' : '已关闭',
            onClick() {
              const newVal = !blockAdEnabled;
              try {
                localStorage.setItem('enable_blockad', String(newVal));
                setVideoLoadingStage('initing');
                setIsVideoLoading(true);
                if (artPlayerRef.current) {
                  resumeTimeRef.current = artPlayerRef.current.currentTime;
                  if (
                    artPlayerRef.current.video &&
                    artPlayerRef.current.video.hls
                  ) {
                    artPlayerRef.current.video.hls.destroy();
                  }
                  wakeLockRef.current?.disable();
                  artPlayerRef.current.destroy();
                  artPlayerRef.current = null;
                }
                setBlockAdEnabled(newVal);
              } catch (_) {
                // ignore
              }
              return newVal ? '当前开启' : '当前关闭';
            },
          },
          {
            name: '跳过片头片尾',
            html: '跳过片头片尾',
            switch: skipConfigRef.current.enable,
            onSwitch: function (item) {
              const newConfig = {
                ...skipConfigRef.current,
                enable: !item.switch,
              };
              handleSkipConfigChange(newConfig);
              return !item.switch;
            },
          },
          {
            html: '删除跳过配置',
            onClick: function () {
              handleSkipConfigChange({
                enable: false,
                intro_time: 0,
                outro_time: 0,
              });
              return '';
            },
          },
          {
            name: '设置片头',
            html: '设置片头',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="12" r="2" fill="#ffffff"/><path d="M9 12L17 12" stroke="#ffffff" stroke-width="2"/><path d="M17 6L17 18" stroke="#ffffff" stroke-width="2"/></svg>',
            tooltip:
              skipConfigRef.current.intro_time === 0
                ? '设置片头时间'
                : `${formatTime(skipConfigRef.current.intro_time)}`,
            onClick: function () {
              const currentTime = artPlayerRef.current?.currentTime || 0;
              if (currentTime > 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  intro_time: currentTime,
                };
                handleSkipConfigChange(newConfig);
                return `${formatTime(currentTime)}`;
              }
            },
          },
          {
            name: '设置片尾',
            html: '设置片尾',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 6L7 18" stroke="#ffffff" stroke-width="2"/><path d="M7 12L15 12" stroke="#ffffff" stroke-width="2"/><circle cx="19" cy="12" r="2" fill="#ffffff"/></svg>',
            tooltip:
              skipConfigRef.current.outro_time >= 0
                ? '设置片尾时间'
                : `-${formatTime(-skipConfigRef.current.outro_time)}`,
            onClick: function () {
              const outroTime =
                -(
                  artPlayerRef.current?.duration -
                  artPlayerRef.current?.currentTime
                ) || 0;
              if (outroTime < 0) {
                const newConfig = {
                  ...skipConfigRef.current,
                  outro_time: outroTime,
                };
                handleSkipConfigChange(newConfig);
                return `-${formatTime(-outroTime)}`;
              }
            },
          },
          {
            name: '自动连播',
            html: '自动连播',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 5l9 7-9 7V5z" fill="#ffffff"/><path d="M17 5v14" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/></svg>',
            switch: autoNextSetting.switch,
            onSwitch: autoNextSetting.onSwitch,
          },
          {
            name: '单集循环',
            html: '单集循环',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
            switch: false,
            onSwitch: function (item: any) {
              const newVal = !item.switch;
              const video = artPlayerRef.current?.video as
                | HTMLVideoElement
                | undefined;
              if (video) video.loop = newVal;
              return newVal;
            },
          },
          {
            name: '睡眠定时',
            html: '睡眠定时',
            icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>',
            selector: [
              {
                html: '关闭',
                value: 'off',
                default: sleepChoiceRef.current === 'off',
              },
              {
                html: '15 分钟后',
                value: '15',
                default: sleepChoiceRef.current === '15',
              },
              {
                html: '30 分钟后',
                value: '30',
                default: sleepChoiceRef.current === '30',
              },
              {
                html: '60 分钟后',
                value: '60',
                default: sleepChoiceRef.current === '60',
              },
              {
                html: '本集结束',
                value: 'episode',
                default: sleepChoiceRef.current === 'episode',
              },
            ],
            onSelect: function (item: any) {
              applySleepTimer(item.value);
              return item.html;
            },
          },
        ],
        // 控制栏配置
        controls: [
          {
            position: 'left',
            index: 13,
            html: '<i class="art-icon flex"><svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" fill="currentColor"/></svg></i>',
            tooltip: '播放下一集',
            click: function () {
              handleNextEpisode();
            },
          },
          {
            name: 'auto-next',
            position: 'right',
            index: 12,
            html: `<span class="ck-autonext">${
              autoNextRef.current ? '连播开' : '连播关'
            }</span>`,
            tooltip: '本集结束后自动播放下一集',
            style: {
              padding: '0 6px',
              fontSize: '12px',
              cursor: 'pointer',
            },
            mounted(element: HTMLElement) {
              autoNextButton = element.querySelector('.ck-autonext');
              paintAutoNext(autoNextRef.current);
            },
            click() {
              applyAutoNext(!autoNextRef.current);
            },
          },
        ],
      });

      // 监听播放器事件
      playingNodeRef.current =
        (artPlayerRef.current?.video as HTMLVideoElement) || null;
      artPlayerRef.current.on('ready', () => {
        playingNodeRef.current =
          (artPlayerRef.current?.video as HTMLVideoElement) ||
          playingNodeRef.current;
        silenceOtherMedia(artPlayerRef.current?.video as HTMLVideoElement);
        setError(null);

        // 根据用户设置初始化字幕显示状态
        if (artPlayerRef.current && artPlayerRef.current.subtitle) {
          artPlayerRef.current.subtitle.show = subtitleEnabledRef.current;
        }
      });

      artPlayerRef.current.on('video:volumechange', () => {
        lastVolumeRef.current = artPlayerRef.current.volume;
        writeVolume(artPlayerRef.current.volume);
      });
      artPlayerRef.current.on('video:ratechange', () => {
        lastPlaybackRateRef.current = artPlayerRef.current.playbackRate;
      });

      // 监听视频可播放事件，这时恢复播放进度更可靠
      artPlayerRef.current.on('video:canplay', () => {
        // 若存在需要恢复的播放进度，则跳转
        if (resumeTimeRef.current && resumeTimeRef.current > 0) {
          try {
            const duration = artPlayerRef.current.duration || 0;
            let target = resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            artPlayerRef.current.currentTime = target;
          } catch (err) {
            console.warn('恢复播放进度失败:', err);
          }
        }
        resumeTimeRef.current = null;

        setTimeout(() => {
          if (
            Math.abs(artPlayerRef.current.volume - lastVolumeRef.current) > 0.01
          ) {
            artPlayerRef.current.volume = lastVolumeRef.current;
          }
          if (
            Math.abs(
              artPlayerRef.current.playbackRate - lastPlaybackRateRef.current
            ) > 0.01 &&
            isWebkit
          ) {
            artPlayerRef.current.playbackRate = lastPlaybackRateRef.current;
          }
          artPlayerRef.current.notice.show = '';
        }, 0);

        // 隐藏换源加载状态
        setIsVideoLoading(false);
      });

      // 监听视频时间更新事件，实现跳过片头片尾
      artPlayerRef.current.on('video:timeupdate', () => {
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;
        const now = Date.now();

        // 限制跳过检查频率为1.5秒一次
        if (now - lastSkipCheckRef.current < 1500) return;
        lastSkipCheckRef.current = now;

        // 跳过片头
        if (
          skipConfigRef.current.intro_time > 0 &&
          currentTime < skipConfigRef.current.intro_time
        ) {
          artPlayerRef.current.currentTime = skipConfigRef.current.intro_time;
          artPlayerRef.current.notice.show = `已跳过片头 (${formatTime(
            skipConfigRef.current.intro_time
          )})`;
        }

        // 跳过片尾
        if (
          !artPlayerRef.current.video?.loop &&
          skipConfigRef.current.outro_time < 0 &&
          duration > 0 &&
          currentTime >
            artPlayerRef.current.duration + skipConfigRef.current.outro_time
        ) {
          if (
            autoNextRef.current &&
            currentEpisodeIndexRef.current <
              (detailRef.current?.episodes?.length || 1) - 1
          ) {
            handleNextEpisode();
            artPlayerRef.current.notice.show = `已跳过片尾 (${formatTime(
              skipConfigRef.current.outro_time
            )})`;
          } else {
            // 连播关着或已是最后一集：停在片尾，不说「已跳过」
            artPlayerRef.current.pause();
            artPlayerRef.current.notice.show = '已到片尾，已暂停播放';
          }
        }
      });

      artPlayerRef.current.on('error', () => {
        failOverRef.current();
      });

      // 播放与暂停：同步锁屏状态，并在播放时保持屏幕常亮
      artPlayerRef.current.on('video:play', () => {
        setMediaPlaybackState('playing');
        wakeLockRef.current?.enable();
      });
      artPlayerRef.current.on('video:pause', () => {
        setMediaPlaybackState('paused');
        wakeLockRef.current?.disable();
      });

      // 锁屏进度条：每秒报一次位置
      let lastMediaPositionAt = 0;
      artPlayerRef.current.on('video:timeupdate', () => {
        // 单集循环时不会派发结束事件，「本集结束」改为在这一遍快播完时暂停
        const loopVideo = artPlayerRef.current?.video as
          | HTMLVideoElement
          | undefined;
        if (
          loopVideo &&
          loopVideo.loop &&
          sleepEndOfEpisodeRef.current &&
          loopVideo.duration > 0 &&
          loopVideo.currentTime >= loopVideo.duration - 0.5
        ) {
          loopVideo.pause();
          applySleepTimer('off');
          artPlayerRef.current.notice.show = '本集已播完，睡眠定时已暂停播放';
          return;
        }
        const now = Date.now();
        if (now - lastMediaPositionAt < 1000) return;
        lastMediaPositionAt = now;
        const video = artPlayerRef.current?.video as
          | HTMLVideoElement
          | undefined;
        if (video) {
          setMediaPosition({
            position: video.currentTime,
            duration: video.duration,
            playbackRate: video.playbackRate,
          });
        }
      });

      // 播放结束：睡眠定时优先。连播开着就进下一集，关着就停在当前这一集。
      artPlayerRef.current.on('video:ended', () => {
        wakeLockRef.current?.disable();
        setMediaPlaybackState('paused');
        if (sleepEndOfEpisodeRef.current) {
          applySleepTimer('off');
          artPlayerRef.current.notice.show = '本集已播完，睡眠定时已暂停播放';
          return;
        }
        const d = detailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (
          !autoNextRef.current ||
          !d?.episodes ||
          idx >= d.episodes.length - 1
        ) {
          return;
        }
        handleNextEpisode();
      });

      artPlayerRef.current.on('video:timeupdate', () => {
        const now = Date.now();
        let interval = 5000;
        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'd1') {
          interval = 10000;
        }
        if (process.env.NEXT_PUBLIC_STORAGE_TYPE === 'upstash') {
          interval = 20000;
        }
        if (now - lastSaveTimeRef.current > interval) {
          saveCurrentPlayProgress();
          lastSaveTimeRef.current = now;
        }
      });

      // 设置当前视频 URL（用于 AI 字幕）
      setCurrentVideoUrl(videoUrl);

      artPlayerRef.current.on('pause', () => {
        saveCurrentPlayProgress();
      });
    } catch (err) {
      console.error('创建播放器失败:', err);
      setError('播放器初始化失败');
    }
  }, [Artplayer, Hls, videoUrl, loading, blockAdEnabled]);

  // 锁屏与通知栏：集数变化时更新标题和封面，按钮只保留当前能用的（没有上一集就不显示上一集）
  useEffect(() => {
    if (!detail) return;
    const idx = currentEpisodeIndex;
    const total = detail.episodes ? detail.episodes.length : 0;
    const episodeLabel = total > 1 ? ' 第' + (idx + 1) + '集' : '';
    setMediaInfo({
      title: (videoTitle || detail.title) + episodeLabel,
      album: detail.source_name,
      artwork: processImageUrl(videoCover || detail.poster),
    });
    const playSafely = () => {
      const player = artPlayerRef.current;
      const result = player ? player.play() : undefined;
      if (result && typeof result.catch === 'function')
        result.catch(() => undefined);
    };
    return bindMediaActions({
      play: playSafely,
      pause: () => artPlayerRef.current?.pause(),
      seekBackward: () => {
        const player = artPlayerRef.current;
        if (player) player.currentTime = Math.max(0, player.currentTime - 10);
      },
      seekForward: () => {
        const player = artPlayerRef.current;
        if (player) {
          player.currentTime = Math.min(
            player.duration || 0,
            player.currentTime + 10
          );
        }
      },
      previousTrack: idx > 0 ? handlePreviousEpisode : undefined,
      nextTrack: idx < total - 1 ? handleNextEpisode : undefined,
    });
    // 切换集数时重新绑定，按钮要拿到最新的切集函数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, currentEpisodeIndex, videoTitle, videoCover]);

  // 离开播放页就停。画中画还在时先留着，退出画中画再拆。
  useLayoutEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
      const player = artPlayerRef.current;
      const video =
        playingNodeRef.current ||
        (player?.video as HTMLVideoElement | undefined);
      playingNodeRef.current = null;
      artPlayerRef.current = null;
      releaseMedia(video, () => {
        try {
          video?.hls?.destroy();
        } catch {
          // 这条 HLS 已经拆过。
        }
        try {
          player?.destroy();
        } catch {
          // 页面已经把容器卸掉。
        }
      });
    };
  }, []);

  if (loading) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex min-h-svh items-center justify-center px-6'>
          <div className='w-full max-w-sm'>
            <p className='mb-3 text-sm text-gray-700 dark:text-gray-200'>
              {loadingMessage}
            </p>
            <div className='h-1 bg-gray-200 dark:bg-gray-700'>
              <div
                className='h-full bg-green-600'
                style={{
                  width:
                    loadingStage === 'searching' || loadingStage === 'fetching'
                      ? '33%'
                      : loadingStage === 'preferring'
                      ? '66%'
                      : '100%',
                }}
              />
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout activePath='/play'>
        <div className='flex min-h-svh items-center justify-center px-6'>
          <div className='w-full max-w-sm'>
            <h2 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
              播放失败
            </h2>
            <p className='mt-2 text-sm text-gray-600 dark:text-gray-300'>
              {error}
            </p>
            <div className='mt-4 flex gap-2'>
              <button
                type='button'
                onClick={() =>
                  videoTitle
                    ? router.push(`/search?q=${encodeURIComponent(videoTitle)}`)
                    : router.back()
                }
                className='border border-green-600 bg-green-600 px-4 py-2 text-sm text-white'
              >
                {videoTitle ? '返回搜索' : '返回上页'}
              </button>
              <button
                type='button'
                onClick={() => window.location.reload()}
                className='border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200'
              >
                重新尝试
              </button>
            </div>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout activePath='/play'>
      <div className='flex flex-col gap-3 py-4 px-5 lg:px-[3rem] 2xl:px-20'>
        {/* 第一行：影片标题 */}
        <div className='py-1'>
          <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
            {videoTitle || '影片标题'}
            {totalEpisodes > 1 && (
              <span className='text-gray-500 dark:text-gray-400'>
                {` > 第 ${currentEpisodeIndex + 1} 集`}
              </span>
            )}
          </h1>
        </div>
        {/* 第二行：播放器和选集 */}
        <div className='space-y-2'>
          {/* 控制栏：投屏按钮 + 折叠控制 */}
          <div className='flex items-center justify-between'>
            {/* 投屏按钮 */}
            <button
              onClick={() => setIsTVCastModalOpen(true)}
              className='flex items-center gap-1.5 border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:border-green-600 hover:text-green-700 dark:border-gray-600 dark:text-gray-200'
              title='电视投屏'
            >
              <svg className='w-4 h-4' viewBox='0 0 24 24' fill='currentColor'>
                <path d='M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z' />
              </svg>
              <span className='text-xs font-medium'>投屏</span>
            </button>

            {/* 折叠控制 - 仅在 lg 及以上屏幕显示 */}
            <button
              onClick={() =>
                setIsEpisodeSelectorCollapsed(!isEpisodeSelectorCollapsed)
              }
              className='hidden items-center gap-1.5 border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:border-green-600 hover:text-green-700 dark:border-gray-600 dark:text-gray-200 lg:flex'
              title={
                isEpisodeSelectorCollapsed ? '显示选集面板' : '隐藏选集面板'
              }
            >
              <svg
                className={`w-3.5 h-3.5 text-gray-500 dark:text-gray-400 transition-transform duration-200 ${
                  isEpisodeSelectorCollapsed ? 'rotate-180' : 'rotate-0'
                }`}
                fill='none'
                stroke='currentColor'
                viewBox='0 0 24 24'
              >
                <path
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth='2'
                  d='M9 5l7 7-7 7'
                />
              </svg>
              <span>
                {isEpisodeSelectorCollapsed ? '显示选集' : '隐藏选集'}
              </span>
            </button>
          </div>

          <div
            className={`grid gap-4 lg:h-[500px] xl:h-[650px] 2xl:h-[750px] transition-all duration-300 ease-in-out ${
              isEpisodeSelectorCollapsed
                ? 'grid-cols-1'
                : 'grid-cols-1 md:grid-cols-4'
            }`}
          >
            {/* 播放器 */}
            <div
              className={`h-full transition-all duration-300 ease-in-out rounded-xl border border-white/0 dark:border-white/30 ${
                isEpisodeSelectorCollapsed ? 'col-span-1' : 'md:col-span-3'
              }`}
            >
              <div className='relative aspect-video w-full lg:aspect-auto lg:h-full'>
                <div
                  ref={artRef}
                  className='bg-black w-full h-full rounded-xl overflow-hidden shadow-lg'
                ></div>

                {/* Cloudflare AI 字幕 */}
                <CloudflareAISubtitle
                  enabled={aiSubtitleEnabled}
                  videoUrl={currentVideoUrl}
                  language='zh'
                />

                {/* 换源加载蒙层 */}
                {isVideoLoading && (
                  <div
                    role='status'
                    aria-live='polite'
                    className='absolute inset-0 z-[500] flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center'
                  >
                    {videoLoadingStage === 'stalled' ? (
                      <>
                        <p className='text-sm text-white'>{loadingHint}</p>
                        {pickNextSource() ? (
                          <button
                            type='button'
                            onClick={switchLineManually}
                            className='rounded-full bg-green-600 px-4 py-1.5 text-sm text-white transition-colors hover:bg-green-700'
                          >
                            换一条线路
                          </button>
                        ) : (
                          <p className='text-xs text-white/60'>
                            暂无其他可用线路，可以稍后重试
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <span
                          aria-hidden='true'
                          className='h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-white'
                        />
                        <p className='text-sm text-white'>
                          {videoLoadingStage === 'sourceChanging'
                            ? '切换线路'
                            : '正在缓冲'}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 选集和换源 - 在移动端始终显示，在 lg 及以上可折叠 */}
            <div
              className={`h-[300px] lg:h-full md:overflow-hidden transition-all duration-300 ease-in-out ${
                isEpisodeSelectorCollapsed
                  ? 'md:col-span-1 lg:hidden lg:opacity-0 lg:scale-95'
                  : 'md:col-span-1 lg:opacity-100 lg:scale-100'
              }`}
            >
              <EpisodeSelector
                totalEpisodes={totalEpisodes}
                value={currentEpisodeIndex + 1}
                onChange={handleEpisodeChange}
                onSourceChange={handleSourceChange}
                currentSource={currentSource}
                currentId={currentId}
                videoTitle={searchTitle || videoTitle}
                availableSources={availableSources}
                sourceSearchLoading={sourceSearchLoading}
                sourceSearchError={sourceSearchError}
              />
            </div>
          </div>
        </div>

        {/* 详情展示 */}
        <div className='grid grid-cols-1 md:grid-cols-4 gap-4'>
          {/* 文字区 */}
          <div className='md:col-span-3'>
            <div className='p-6 flex flex-col min-h-0'>
              {/* 标题 */}
              <h1 className='text-3xl font-bold mb-2 tracking-wide flex items-center flex-shrink-0 text-center md:text-left w-full'>
                {videoTitle || '影片标题'}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleFavorite();
                  }}
                  className='ml-3 flex-shrink-0 hover:opacity-80 transition-opacity'
                >
                  <FavoriteIcon filled={favorited} />
                </button>
              </h1>

              {/* 关键信息行 */}
              <div className='flex flex-wrap items-center gap-3 text-base mb-4 opacity-80 flex-shrink-0'>
                {detail?.class && (
                  <span className='text-green-600 font-semibold'>
                    {detail.class}
                  </span>
                )}
                {(detail?.year || videoYear) && (
                  <span>{detail?.year || videoYear}</span>
                )}
                {detail?.source_name && (
                  <span className='border border-gray-500/60 px-2 py-[1px] rounded'>
                    {detail.source_name}
                  </span>
                )}
                {detail?.type_name && <span>{detail.type_name}</span>}
              </div>
              {/* 防诈骗提醒：紧跟标题信息，只占一行，不挤压播放器和选集 */}
              <div className='mb-4 flex-shrink-0'>
                <ScamNotice />
              </div>
              {/* 剧情简介 */}
              {detail?.desc && (
                <div
                  className='mt-0 text-base leading-relaxed opacity-90 overflow-y-auto pr-2 flex-1 min-h-0 scrollbar-hide'
                  style={{ whiteSpace: 'pre-line' }}
                >
                  {detail.desc}
                </div>
              )}
            </div>
          </div>

          {/* 封面展示 */}
          <div className='hidden md:block md:col-span-1 md:order-first'>
            <div className='pl-0 py-4 pr-6'>
              <div className='bg-gray-300 dark:bg-gray-700 aspect-[2/3] flex items-center justify-center rounded-xl overflow-hidden'>
                {videoCover ? (
                  <img
                    src={processImageUrl(videoCover)}
                    alt={videoTitle}
                    className='w-full h-full object-cover'
                  />
                ) : (
                  <span className='text-gray-600 dark:text-gray-400'>
                    封面图片
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 电视投屏弹窗 */}
      <TVCastModal
        isOpen={isTVCastModalOpen}
        onClose={() => setIsTVCastModalOpen(false)}
        videoUrl={videoUrl}
        videoTitle={videoTitle}
        videoPoster={videoCover}
        episodeIndex={currentEpisodeIndex}
        getCurrentTime={() => artPlayerRef.current?.currentTime || 0}
        onPrepareAirPlay={prepareAirPlay}
        onRestoreLocal={restoreLocalHls}
      />
    </PageLayout>
  );
}

// FavoriteIcon 组件
const FavoriteIcon = ({ filled }: { filled: boolean }) => {
  if (filled) {
    return (
      <svg
        className='h-7 w-7'
        viewBox='0 0 24 24'
        xmlns='http://www.w3.org/2000/svg'
      >
        <path
          d='M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'
          fill='#ef4444' /* Tailwind red-500 */
          stroke='#ef4444'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    );
  }
  return (
    <Heart className='h-7 w-7 stroke-[1] text-gray-600 dark:text-gray-300' />
  );
};

function PlayPageEntry() {
  const searchParams = useSearchParams();
  // 同一页只换查询参数时，播放器不会自己拆掉。换一部就整页重挂，上一集不会留在画面里。
  const opened = [
    searchParams.get('source') || '',
    searchParams.get('id') || '',
    searchParams.get('stitle') || '',
    searchParams.get('title') || '',
  ].join('\n');
  return <PlayPageClient key={opened} />;
}

export default function PlayPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlayPageEntry />
    </Suspense>
  );
}
