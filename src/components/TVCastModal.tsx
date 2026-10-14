'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { airPlayPicker, watchAirPlayTargets } from '@/lib/airplay';
import {
  buildCastRequest,
  castSdkReady,
  loadCastSdk,
  observeCast,
  startCast,
  stopCast,
} from '@/lib/cast';
import {
  type CastSupport,
  castSupport,
  toAbsoluteUrl,
} from '@/lib/cast-support';

interface TVCastModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  videoTitle: string;
  videoPoster?: string;
  episodeIndex?: number;
  getCurrentTime?: () => number;
  // AirPlay 要先切到原生 HLS 的原始地址；返回 false 表示这条地址切不过去
  onPrepareAirPlay?: () => Promise<boolean>;
  // 弹窗关闭且没有投到 AirPlay 设备时调用，把本机播放切回 hls.js（去广告）
  onRestoreLocal?: () => void;
}

type Tab = 'cast' | 'qrcode' | 'link';

// 播放器容器里的 video（ArtPlayer 挂在 .art-video-player 下面）
function playerVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('.art-video-player video') ??
    document.querySelector<HTMLVideoElement>('video')
  );
}

// 把 Cast SDK 的错误翻成能照着做的提示
function castErrorMessage(err: unknown): string {
  const code =
    typeof err === 'string'
      ? err
      : (err as { code?: string; message?: string })?.code ||
        (err as Error)?.message ||
        '';
  if (code === 'cancel') return '已取消选择设备';
  if (code === 'receiver_unavailable' || code === 'NO_DEVICES_AVAILABLE') {
    return '没有找到可用的电视，请确认电视和手机在同一个 Wi-Fi';
  }
  if (/LOAD|INVALID|NOT_SUPPORTED/i.test(code)) {
    return '电视无法播放这个地址，可以换一集或换一条线路再试';
  }
  return '投屏没有成功，请确认电视已开机并在同一网络后重试';
}

// 告诉用户在这台设备上该用哪种方式，而不是让他们猜
function platformHint(support: CastSupport | null): string {
  if (!support) return '';
  if (support.engine === 'webkit') {
    return 'iPhone、iPad、Mac 请用 Safari 点击 AirPlay。iOS 上的 Chrome 等浏览器不支持 Chromecast。';
  }
  if (support.engine === 'chromium') {
    return 'Android、Windows、Mac 上用 Chrome 或 Edge 点击 Chromecast，电视和手机需在同一 Wi-Fi。';
  }
  return '当前浏览器不支持直接投屏。请用 Chrome 或 Edge 打开，或切换到「扫码」「链接」。';
}

function Option({
  label,
  hint,
  onClick,
  disabled,
  active,
  icon,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-[44px] flex-col items-center gap-1.5 rounded-xl border p-4 text-center transition-all disabled:opacity-60 ${
        active
          ? 'border-green-500 bg-green-500/20 text-green-400'
          : 'border-gray-700 bg-gray-800/50 text-gray-300 sm:hover:border-green-500 sm:hover:bg-green-500/10 active:bg-green-500/10'
      }`}
    >
      <span className='h-8 w-8'>{icon}</span>
      <span className='text-sm font-medium'>{label}</span>
      <span className='text-xs text-gray-500'>{hint}</span>
    </button>
  );
}

export default function TVCastModal({
  isOpen,
  onClose,
  videoUrl,
  videoTitle,
  videoPoster,
  episodeIndex,
  getCurrentTime,
  onPrepareAirPlay,
  onRestoreLocal,
}: TVCastModalProps) {
  const [tab, setTab] = useState<Tab>('cast');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cast, setCast] = useState({ connected: false, device: '' });
  const [airAvailable, setAirAvailable] = useState<boolean | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const unobserveRef = useRef<(() => void) | null>(null);
  const sdkRef = useRef<Promise<boolean> | null>(null);
  const prepareRef = useRef(onPrepareAirPlay);
  const restoreRef = useRef(onRestoreLocal);
  const openRef = useRef(isOpen);
  // 当前已经切到原生地址的那个 video；换了播放器（换集）就不再是它
  const airReadyRef = useRef<HTMLVideoElement | null>(null);
  const unwatchAirRef = useRef<(() => void) | null>(null);

  // 按浏览器内核决定显示哪些投屏方式，打开时判断一次
  const support = useMemo<CastSupport | null>(
    () =>
      isOpen && typeof navigator !== 'undefined'
        ? castSupport({
            userAgent: navigator.userAgent,
            vendor: navigator.vendor,
          })
        : null,
    [isOpen]
  );

  useEffect(() => {
    prepareRef.current = onPrepareAirPlay;
    restoreRef.current = onRestoreLocal;
    openRef.current = isOpen;
  }, [onPrepareAirPlay, onRestoreLocal, isOpen]);

  // 关闭后清掉临时提示；投屏是否连着由 Cast SDK 决定，这里不重置
  useEffect(() => {
    if (!isOpen) {
      setMessage('');
      setCopied(false);
      setTab('cast');
    }
  }, [isOpen]);

  // 加载并订阅 Cast SDK。打开时就预加载，点击时直接发起投屏，避免等下载后用户激活已过期
  const ensureSdk = useCallback(async (): Promise<boolean> => {
    if (!sdkRef.current) sdkRef.current = loadCastSdk();
    const ok = await sdkRef.current;
    if (!ok) {
      sdkRef.current = null; // 下次点击会重新加载
      return false;
    }
    if (!unobserveRef.current) unobserveRef.current = observeCast(setCast);
    return true;
  }, []);

  useEffect(() => {
    if (isOpen && support?.chromecast) void ensureSdk();
  }, [isOpen, support, ensureSdk]);

  // 订阅 AirPlay 设备是否可用。只绑在当前已切换的 video 上；换了播放器就重新绑
  const watchAir = useCallback((video: HTMLVideoElement) => {
    unwatchAirRef.current?.();
    unwatchAirRef.current = watchAirPlayTargets(video, setAirAvailable);
  }, []);

  // Safari：打开时先把播放切到原生 HLS，点 AirPlay 时才能同步调出选择器（保留用户手势）。
  // 关闭弹窗时，如果没有投到 AirPlay 设备，就切回 hls.js，去广告恢复。
  useEffect(() => {
    if (!isOpen || !support?.airplay) return;
    let alive = true;
    const pending = prepareRef.current
      ? prepareRef.current()
      : Promise.resolve(true);
    pending.then((ok) => {
      const video = playerVideo();
      if (!alive) {
        // 切换在弹窗关闭之后才完成，这时立刻切回去
        if (ok) restoreRef.current?.();
        return;
      }
      airReadyRef.current = ok ? video : null;
      if (ok && video) watchAir(video);
    });
    return () => {
      alive = false;
      if (airReadyRef.current) restoreRef.current?.();
      airReadyRef.current = null;
      unwatchAirRef.current?.();
      unwatchAirRef.current = null;
      setAirAvailable(null);
    };
  }, [isOpen, support, watchAir]);

  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  useEffect(
    () => () => {
      unobserveRef.current?.();
      unobserveRef.current = null;
    },
    []
  );

  if (!isOpen) return null;

  const pageUrl = (() => {
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    if (typeof episodeIndex === 'number') {
      url.searchParams.set('ep', String(episodeIndex));
    }
    return url.toString();
  })();

  const handleChromecast = async () => {
    const plan = buildCastRequest({
      url: videoUrl,
      title: videoTitle,
      // 封面可能是站内相对地址（如黄果封面接口），要补全成电视能访问的绝对地址
      poster: toAbsoluteUrl(videoPoster, window.location.href),
      currentTime: getCurrentTime?.() ?? 0,
    });
    if (!plan) {
      setMessage('这条播放地址只能在本站访问，电视无法直接播放');
      return;
    }
    // 组件还没就绪时不能在这里等下载：等待会让浏览器的用户激活过期，选设备就会被拒绝。
    // 先在后台加载，请用户再点一次。
    if (!castSdkReady()) {
      setMessage('投屏组件正在加载，加载好后请再点一次');
      void ensureSdk().then((ok) => {
        if (!ok)
          setMessage('没能加载投屏组件，请用 Chrome 或 Edge 打开并检查网络');
      });
      return;
    }
    setBusy(true);
    setMessage('请在弹出的列表里选择电视');
    try {
      // 进度在选完电视后再读，选台期间视频还在走
      const result = await startCast(plan, undefined, getCurrentTime);
      // 电视在放了，本机暂停，否则声音会叠在一起
      playerVideo()?.pause();
      setCast({ connected: true, device: result.device });
      setMessage('');
    } catch (err) {
      setMessage(castErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStop = () => {
    stopCast();
    setCast({ connected: false, device: '' });
    setMessage('已停止投屏');
  };

  const handleAirPlay = () => {
    const video = playerVideo();
    if (!video) {
      setMessage('请先开始播放');
      return;
    }
    // 还没切到原生地址（或者换了播放器）：后台切换，请用户再点一次。
    // 选择器必须在点击的同一个调用里弹出才能保住用户手势，所以这里不 await。
    if (airReadyRef.current !== video) {
      setMessage('正在切换到 AirPlay 播放，准备好后请再点一次');
      const pending = prepareRef.current
        ? prepareRef.current()
        : Promise.resolve(true);
      void pending.then((ok) => {
        const current = playerVideo();
        if (!ok || !current) {
          airReadyRef.current = null;
          setMessage('这条播放地址无法切到 AirPlay，可以换一条线路再试');
          return;
        }
        if (!openRef.current) {
          // 切换完成时弹窗已经关了，立刻切回 hls.js
          restoreRef.current?.();
          return;
        }
        airReadyRef.current = current;
        watchAir(current);
        setMessage('');
      });
      return;
    }
    const result = airPlayPicker(video);
    if (result === 'shown') {
      setMessage(
        airAvailable === false
          ? '没有找到 AirPlay 设备，请确认 Apple TV 与手机在同一 Wi-Fi'
          : ''
      );
    } else if (result === 'no-video') {
      setMessage('请先开始播放');
    } else {
      setMessage('当前浏览器不支持 AirPlay，请用 Safari 打开本页');
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
    setMessage(label + '已复制');
    setTimeout(() => {
      setCopied(false);
      setMessage('');
    }, 2000);
  };

  return (
    <div
      role='dialog'
      aria-modal='true'
      aria-labelledby='tvcast-title'
      className='fixed inset-0 z-[9999] flex items-center justify-center p-4'
    >
      <div
        className='absolute inset-0 bg-black/60 backdrop-blur-sm'
        onClick={onClose}
      />
      <div className='relative w-full max-w-md overflow-hidden rounded-2xl bg-[#1a1a1a] shadow-2xl'>
        <div className='flex items-center justify-between border-b border-gray-800 px-5 py-4'>
          <h2 id='tvcast-title' className='text-lg font-bold text-white'>
            电视投屏
          </h2>
          <button
            ref={closeRef}
            type='button'
            onClick={onClose}
            aria-label='关闭'
            className='flex h-11 w-11 items-center justify-center rounded-full hover:bg-white/10'
          >
            <svg
              className='h-5 w-5 text-gray-400'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                strokeWidth={2}
                d='M6 18L18 6M6 6l12 12'
              />
            </svg>
          </button>
        </div>

        <div role='tablist' className='flex border-b border-gray-800'>
          {(['cast', 'qrcode', 'link'] as const).map((item) => (
            <button
              key={item}
              type='button'
              role='tab'
              aria-selected={tab === item}
              onClick={() => setTab(item)}
              className={`min-h-[44px] flex-1 py-3 text-sm font-medium ${
                tab === item
                  ? 'border-b-2 border-green-400 text-green-400'
                  : 'text-gray-400'
              }`}
            >
              {item === 'cast' ? '投屏' : item === 'qrcode' ? '扫码' : '链接'}
            </button>
          ))}
        </div>

        <div className='p-5'>
          {tab === 'cast' && (
            <div className='space-y-4'>
              <div className='grid grid-cols-2 gap-3'>
                {support?.chromecast && (
                  <Option
                    label={
                      cast.connected
                        ? '已投屏'
                        : busy
                        ? '连接中…'
                        : 'Chromecast'
                    }
                    hint={
                      cast.connected
                        ? `${cast.device}（点此停止）`
                        : '安卓 / 电脑 Chrome'
                    }
                    active={cast.connected}
                    disabled={busy}
                    onClick={cast.connected ? handleStop : handleChromecast}
                    icon={
                      <svg viewBox='0 0 24 24' fill='currentColor'>
                        <path d='M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z' />
                      </svg>
                    }
                  />
                )}
                {support?.airplay && (
                  <Option
                    label='AirPlay'
                    hint={
                      airAvailable === false ? '未发现设备' : 'Safari 选择设备'
                    }
                    onClick={handleAirPlay}
                    icon={
                      <svg viewBox='0 0 24 24' fill='currentColor'>
                        <path d='M6 3.5l6 8.5 6-8.5v1.5l-6 8.5-6-8.5zM6 11l6 8.5 6-8.5v1.5l-6 8.5-6-8.5z' />
                      </svg>
                    }
                  />
                )}
                <Option
                  label='扫码打开'
                  hint='电视浏览器扫码'
                  onClick={() => setTab('qrcode')}
                  icon={
                    <svg
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        d='M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2v2h-2z'
                      />
                    </svg>
                  }
                />
                <Option
                  label={copied ? '已复制' : '复制播放地址'}
                  hint='可粘贴到 VLC 等播放器'
                  onClick={() => copyText(videoUrl, '播放地址')}
                  icon={
                    <svg
                      viewBox='0 0 24 24'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap='round'
                        strokeLinejoin='round'
                        d='M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2'
                      />
                    </svg>
                  }
                />
              </div>
              <p className='text-center text-xs leading-relaxed text-gray-500'>
                {platformHint(support)}
              </p>
            </div>
          )}

          {tab === 'qrcode' && (
            <div className='space-y-4'>
              <div className='flex justify-center'>
                <div className='rounded-2xl bg-white p-4'>
                  <QRCodeSVG value={pageUrl} size={180} level='M' />
                </div>
              </div>
              <p className='text-center text-xs text-gray-500'>
                用电视浏览器或手机扫码，会打开当前这一集
              </p>
            </div>
          )}

          {tab === 'link' && (
            <div className='space-y-4'>
              <div className='space-y-2'>
                <label
                  className='text-xs text-gray-500'
                  htmlFor='tvcast-page-url'
                >
                  页面链接（当前集）
                </label>
                <div className='flex gap-2'>
                  <input
                    id='tvcast-page-url'
                    value={pageUrl}
                    readOnly
                    className='flex-1 truncate rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300'
                  />
                  <button
                    type='button'
                    onClick={() => copyText(pageUrl, '页面链接')}
                    className={`min-h-[44px] rounded-lg px-4 py-2 text-sm text-white ${
                      copied ? 'bg-green-500' : 'bg-blue-500'
                    }`}
                  >
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
              <div className='space-y-2'>
                <label
                  className='text-xs text-gray-500'
                  htmlFor='tvcast-video-url'
                >
                  视频地址
                </label>
                <div className='flex gap-2'>
                  <input
                    id='tvcast-video-url'
                    value={videoUrl}
                    readOnly
                    className='flex-1 truncate rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300'
                  />
                  <button
                    type='button'
                    onClick={() => copyText(videoUrl, '视频地址')}
                    className='min-h-[44px] rounded-lg bg-blue-500 px-4 py-2 text-sm text-white'
                  >
                    复制
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div aria-live='polite'>
          {message && (
            <div className='mx-5 mb-5 rounded-xl bg-orange-500/20 px-4 py-3 text-center text-sm text-orange-400'>
              {message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
