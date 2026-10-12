'use client';

import Hls from 'hls.js';
import { Radio } from 'lucide-react';
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { LIVE_CHANNELS, LIVE_GROUPS, LiveChannel, LiveGroup } from '@/lib/live';
import { qualityText } from '@/lib/playlist';
import { releaseMedia, silenceOtherMedia } from '@/lib/release-media';

import { choiceClass } from '@/components/ChoiceRow';
import ChoiceRow from '@/components/ChoiceRow';
import PageLayout from '@/components/PageLayout';

type Phase = 'idle' | 'loading' | 'ready' | 'error';

function LivePageClient() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // React 卸掉 DOM 时会先把 videoRef 清空。这里另外留住节点，离开页面才能暂停。
  const nodeRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const tokenRef = useRef(0);
  const clockRef = useRef(0);
  const [group, setGroup] = useState<LiveGroup>('news');
  const [current, setCurrent] = useState<LiveChannel | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [line, setLine] = useState('');
  const [picture, setPicture] = useState('');
  const [delay, setDelay] = useState<number | null>(null);
  // 频道健康检查结果：/api/live/health 在部署环境里检查过的清单可达性和跨域许可
  const [health, setHealth] = useState<
    Record<string, { ok: boolean; reason?: string }>
  >({});
  const [keyword, setKeyword] = useState('');
  const checkedRef = useRef(new Set<string>());

  const playChannel = useCallback((channel: LiveChannel) => {
    const token = ++tokenRef.current;
    window.clearInterval(clockRef.current);
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPicture('');
    setDelay(null);
    const video = videoRef.current;
    silenceOtherMedia(video);
    if (video) {
      video.pause();
      video.removeAttribute('src');
      // 不要对空地址 load()。Chrome 会异步抛 error，下一条线路刚挂上监听就被判失败，然后退回纯音频。
    }
    setCurrent(channel);
    if (channel.kind === 'link') {
      setPhase('idle');
      setLine('');
      return;
    }
    setPhase('loading');
    setLine('');

    const attach = (url: string, audio: boolean) =>
      new Promise<boolean>((resolve) => {
        const node = videoRef.current;
        if (!node || token !== tokenRef.current) {
          resolve(false);
          return;
        }
        let settled = false;
        let hls: Hls | null = null;
        let timer = 0;
        let unlistenFail: () => void = () => undefined;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          unlistenFail();
          node.removeEventListener('loadeddata', onMedia);
          node.removeEventListener('playing', onMedia);
          if (token !== tokenRef.current) {
            hls?.destroy();
            resolve(false);
            return;
          }
          if (ok) {
            hlsRef.current = hls;
            silenceOtherMedia(node);
            node.play().catch(() => undefined);
            resolve(true);
            return;
          }
          window.clearInterval(clockRef.current);
          hls?.destroy();
          node.pause();
          node.removeAttribute('src');
          resolve(false);
        };
        // 只有元数据不算画面。Chrome 会谎称能播 m3u8，结果有声无画。
        const onMedia = () => {
          if (audio) {
            if (node.readyState >= 2) done(true);
            return;
          }
          if (node.videoWidth > 0 && node.readyState >= 2) done(true);
        };
        timer = window.setTimeout(() => done(false), 12000);
        if (node.crossOrigin !== 'anonymous') node.crossOrigin = 'anonymous';
        node.addEventListener('loadeddata', onMedia);
        node.addEventListener('playing', onMedia);
        // 桌面浏览器只要能用 hls.js 就走它。原生 m3u8 只留给没有 MSE 的系统播放器。
        // hls.js 拆掉地址时会 load()，Chrome 接着抛 error。这条 error 不能用来判线路失败。
        if (!Hls.isSupported()) {
          if (node.canPlayType('application/vnd.apple.mpegurl')) {
            let armed = false;
            const onFail = () => {
              if (armed) done(false);
            };
            node.addEventListener('error', onFail);
            unlistenFail = () => {
              node.removeEventListener('error', onFail);
            };
            node.src = url;
            window.setTimeout(() => {
              armed = true;
            }, 0);
            return;
          }
          done(false);
          return;
        }
        // 先锁最高档。直播只留约两个分片的缓冲，落后就小幅追。
        // 手动档遇到分片 404 时，hls.js 默认会清掉锁定再自动降档。这里保住锁定。
        hls = new Hls({
          enableWorker: true,
          capLevelToPlayerSize: false,
          testBandwidth: false,
          abrEwmaDefaultEstimate: 8_000_000,
          preserveManualLevelOnError: true,
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 3,
          maxLiveSyncPlaybackRate: 1.08,
          maxBufferLength: 10,
          maxMaxBufferLength: 18,
          backBufferLength: 8,
          liveDurationInfinity: true,
          manifestLoadingTimeOut: 6000,
          levelLoadingTimeOut: 8000,
        });
        const remember = () => {
          const level = hls?.levels?.[hls.currentLevel];
          const height = videoRef.current?.videoHeight || level?.height || 0;
          // 600 这种高度不要被收成 480p。
          if (height) {
            setPicture(
              height === 480 || height >= 720
                ? qualityText(height)
                : `${height}p`
            );
          }
          // 还没出画时的延迟是缓冲空洞，不显示。
          if (!videoRef.current?.videoWidth) return;
          const latency = hls?.latency;
          if (
            typeof latency === 'number' &&
            Number.isFinite(latency) &&
            latency > 0 &&
            latency < 120
          ) {
            setDelay(Math.round(latency));
          }
        };
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!hls || hls.levels.length === 0) return;
          // 从高往低挑浏览器真能解的一档。解不了的编码锁上去会有声无画。
          let pick = hls.levels.length - 1;
          for (let index = hls.levels.length - 1; index >= 0; index -= 1) {
            const codec = hls.levels[index]?.videoCodec;
            if (
              !codec ||
              (typeof MediaSource !== 'undefined' &&
                MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`))
            ) {
              pick = index;
              break;
            }
          }
          // nextLevel 只锁档，不把正在拉的缓冲冲掉。currentLevel 会立刻换档，直播边缘容易 404。
          hls.nextLevel = pick;
          remember();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, remember);
        hls.on(Hls.Events.FRAG_BUFFERED, remember);
        // 每一档只因缺片降一次，避免同一次 404 连降到底。
        let droppedFrom = -1;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!hls) return;
          const hasPicture = node.videoWidth > 0;
          const failedLevel =
            typeof data.frag?.level === 'number'
              ? data.frag.level
              : hls.loadLevel;
          const fragMiss =
            data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT;
          const codecError =
            data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
            data.details ===
              Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR ||
            data.details ===
              Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR;
          // 这一档分片 404 就锁到下一档。锁住是为了不让带宽估计跳回已经 404 的边缘。
          if (
            failedLevel > 0 &&
            droppedFrom !== failedLevel &&
            (fragMiss || codecError)
          ) {
            droppedFrom = failedLevel;
            hls.nextLevel = failedLevel - 1;
          }
          if (!data.fatal) return;
          if (hasPicture || settled) {
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
              hls.recoverMediaError();
            else hls.startLoad();
            return;
          }
          if (failedLevel > 0) {
            hls.nextLevel = failedLevel - 1;
            hls.startLoad();
            return;
          }
          done(false);
        });
        hls.loadSource(url);
        hls.attachMedia(node);
        window.clearInterval(clockRef.current);
        clockRef.current = window.setInterval(remember, 2000);
      });

    const playList = async (urls: string[], audio: boolean) => {
      for (let index = 0; index < urls.length; index += 1) {
        if (token !== tokenRef.current) return false;
        const ok = await attach(urls[index], audio);
        if (token !== tokenRef.current) return false;
        if (ok) {
          setPhase('ready');
          setLine(audio ? '只有声音' : '');
          return true;
        }
      }
      return false;
    };

    const run = async () => {
      let played = false;
      if (channel.urls?.length) {
        played = await playList(channel.urls, channel.kind === 'audio');
      }
      if (!played && channel.code && token === tokenRef.current) {
        try {
          const response = await fetch(
            `/api/live?id=${encodeURIComponent(channel.id)}&fresh=1`
          );
          const data = (await response.json()) as {
            urls?: string[];
            kind?: string;
          };
          if (token !== tokenRef.current) return;
          const urls = Array.isArray(data.urls) ? data.urls : [];
          if (urls.length > 0) {
            played = await playList(urls, data.kind === 'audio');
          }
        } catch {
          played = false;
        }
      }
      if (token !== tokenRef.current) return;
      if (!played) {
        setPhase('error');
        setLine('没播出来');
      }
    };

    void run();
  }, []);

  useLayoutEffect(() => {
    nodeRef.current = videoRef.current;
  });

  useLayoutEffect(() => {
    const first = LIVE_CHANNELS.find((item) => item.id === 'cctvplus1');
    if (first) playChannel(first);
    return () => {
      tokenRef.current += 1;
      window.clearInterval(clockRef.current);
      const node = nodeRef.current;
      const hls = hlsRef.current;
      hlsRef.current = null;
      releaseMedia(node, () => hls?.destroy());
    };
  }, [playChannel]);

  // 停止当前播放：切到不播放的分组、或需要释放资源时调用，避免声音还在后台播
  const stopPlayback = () => {
    tokenRef.current += 1;
    window.clearInterval(clockRef.current);
    const node = nodeRef.current;
    const hls = hlsRef.current;
    hlsRef.current = null;
    releaseMedia(node, () => hls?.destroy());
  };

  const visible = useMemo(
    () => LIVE_CHANNELS.filter((item) => item.group === group),
    [group]
  );

  // 切到哪一组就检测哪一组里还没检测过的频道，每批最多 25 条
  useEffect(() => {
    const pending = visible
      .filter(
        (item) => item.kind !== 'link' && !checkedRef.current.has(item.id)
      )
      .map((item) => item.id);
    if (pending.length === 0) return;
    pending.forEach((id) => checkedRef.current.add(id));
    const run = async () => {
      for (let i = 0; i < pending.length; i += 25) {
        const batch = pending.slice(i, i + 25);
        try {
          const res = await fetch(
            `/api/live/health?ids=${encodeURIComponent(batch.join(','))}`,
            { cache: 'no-store' }
          );
          const data = await res.json();
          setHealth((prev) => ({ ...prev, ...(data.results || {}) }));
        } catch {
          // 检测失败就保持未知状态，频道照常显示
        }
      }
    };
    void run();
  }, [visible]);

  // 按名字搜索；检测不通过的排到后面但不隐藏（检测在境外节点跑，国内用户可能正常）
  const shown = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    const rank = (id: string) => (health[id] && !health[id].ok ? 1 : 0);
    return visible
      .filter((item) => !needle || item.name.toLowerCase().includes(needle))
      .sort((a, b) => rank(a.id) - rank(b.id));
  }, [visible, keyword, health]);
  const checkedCount = visible.filter((item) => health[item.id]).length;
  const okCount = visible.filter((item) => health[item.id]?.ok).length;

  return (
    <PageLayout activePath='/live'>
      <div className='min-h-screen max-w-full overflow-x-hidden px-3 py-4 pb-8 sm:px-10 sm:py-8'>
        <div className='mb-4 flex items-center gap-3'>
          <Radio className='h-5 w-5 text-green-600' />
          <h1 className='text-xl font-semibold text-gray-900 dark:text-gray-100'>
            直播
          </h1>
        </div>

        <div className='mb-4'>
          <ChoiceRow
            label='分类'
            options={LIVE_GROUPS}
            value={group}
            onChange={(value) => {
              const next = value as LiveGroup;
              // 切到平台分组时视频区会被卸载，先把正在播的流停掉
              if (next === 'platform') stopPlayback();
              setGroup(next);
            }}
          />
        </div>

        {group === 'platform' ? (
          <ul className='max-w-xl border border-gray-200 dark:border-gray-800'>
            {visible.map((item) => (
              <li
                key={item.id}
                className='border-b border-gray-200 last:border-b-0 dark:border-gray-800'
              >
                <a
                  href={item.href}
                  target='_blank'
                  rel='noreferrer'
                  className='block px-3 py-3 hover:bg-gray-50 dark:hover:bg-gray-900'
                >
                  <span className='text-sm text-gray-900 dark:text-gray-100'>
                    {item.name}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <div className='mb-3 max-w-5xl bg-black'>
              <video
                ref={videoRef}
                controls
                playsInline
                crossOrigin='anonymous'
                className='aspect-video w-full bg-black'
              />
            </div>
            <div className='mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300'>
              <span>{current?.name || '选一个频道'}</span>
              {phase === 'loading' ? (
                <span className='text-gray-500'>加载中…</span>
              ) : null}
              {picture ? <span>{picture}</span> : null}
              {delay != null ? <span>延迟 {delay} 秒</span> : null}
              {line ? (
                <span
                  className={
                    phase === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-gray-500 dark:text-gray-400'
                  }
                >
                  {line}
                </span>
              ) : null}
              {current && current.kind !== 'link' ? (
                <button
                  type='button'
                  className={choiceClass(false, true)}
                  onClick={() => playChannel(current)}
                >
                  重试
                </button>
              ) : null}
              {current?.href ? (
                <a
                  href={current.href}
                  target='_blank'
                  rel='noreferrer'
                  className={choiceClass(false, true)}
                >
                  去官网
                </a>
              ) : null}
            </div>
            <div className='mb-2 flex flex-wrap items-center gap-2'>
              <input
                type='search'
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder='搜索频道'
                className='w-44 rounded-md border border-gray-300 bg-white px-2.5 py-1 text-sm text-gray-900 placeholder:text-gray-400 focus:border-green-500 focus:outline-none dark:border-gray-700 dark:bg-zinc-900 dark:text-gray-100'
              />
              <span className='text-xs text-gray-500'>
                共 {shown.length} 个频道
                {checkedCount > 0 ? `，检测通过 ${okCount} 个` : ''}
              </span>
            </div>
            <div className='flex flex-wrap gap-1.5'>
              {shown.map((item) => {
                const state = health[item.id];
                const dim = state && !state.ok;
                return (
                  <button
                    key={item.id}
                    type='button'
                    title={dim ? `检测异常：${state.reason}` : undefined}
                    className={`${choiceClass(current?.id === item.id, true)}${
                      dim ? ' opacity-60' : ''
                    }`}
                    onClick={() => playChannel(item)}
                  >
                    {item.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}

export default function LivePage() {
  return (
    <Suspense>
      <LivePageClient />
    </Suspense>
  );
}
