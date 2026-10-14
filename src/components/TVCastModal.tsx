'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';

import { airPlayPicker } from '@/lib/airplay';
import {
  buildCastRequest,
  castSdkReady,
  loadCastSdk,
  observeCast,
  startCast,
  stopCast,
} from '@/lib/cast';

interface TVCastModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  videoTitle: string;
  videoPoster?: string;
  episodeIndex?: number;
  getCurrentTime?: () => number;
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
      className={`flex flex-col items-center gap-1.5 rounded-xl border p-4 text-center transition-all disabled:opacity-60 ${
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
}: TVCastModalProps) {
  const [tab, setTab] = useState<Tab>('cast');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cast, setCast] = useState({ connected: false, device: '' });
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const unobserveRef = useRef<(() => void) | null>(null);

  // 关闭后清掉临时提示；投屏是否连着由 Cast SDK 决定，这里不重置
  useEffect(() => {
    if (!isOpen) {
      setMessage('');
      setCopied(false);
      setTab('cast');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    closeRef.current?.focus();
    if (!unobserveRef.current && castSdkReady()) {
      unobserveRef.current = observeCast(setCast);
    }
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
      poster: videoPoster,
      currentTime: getCurrentTime?.() ?? 0,
    });
    if (!plan) {
      setMessage('这条播放地址只能在本站访问，电视无法直接播放');
      return;
    }
    setBusy(true);
    setMessage('正在加载投屏组件…');
    const ready = await loadCastSdk();
    if (!ready) {
      setBusy(false);
      setMessage('没能加载投屏组件，请用 Chrome 或 Edge 打开并检查网络');
      return;
    }
    if (!unobserveRef.current) unobserveRef.current = observeCast(setCast);
    setMessage('请在弹出的列表里选择电视');
    try {
      // 进度在选完电视后再读，选台期间视频还在走
      const result = await startCast(plan, undefined, getCurrentTime);
      // 电视在放了，本机静音暂停，否则声音会叠在一起
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
    const result = airPlayPicker(playerVideo());
    if (result === 'shown') setMessage('');
    else if (result === 'no-video') setMessage('请先开始播放');
    else
      setMessage(
        'AirPlay 只能在 Safari 里使用，请用 iPhone 或 Mac 的 Safari 打开本页'
      );
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
            className='flex h-8 w-8 items-center justify-center rounded-full hover:bg-white/10'
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
              className={`flex-1 py-3 text-sm font-medium ${
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
            <div className='grid grid-cols-2 gap-3'>
              <Option
                label={
                  cast.connected ? '已投屏' : busy ? '连接中…' : 'Chromecast'
                }
                hint={
                  cast.connected
                    ? `${cast.device}（点此停止）`
                    : 'Chrome / Edge'
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
              <Option
                label='AirPlay'
                hint='Safari / iPhone'
                onClick={handleAirPlay}
                icon={
                  <svg viewBox='0 0 24 24' fill='currentColor'>
                    <path d='M6 3.5l6 8.5 6-8.5v1.5l-6 8.5-6-8.5zM6 11l6 8.5 6-8.5v1.5l-6 8.5-6-8.5z' />
                  </svg>
                }
              />
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
                    className={`rounded-lg px-4 py-2 text-sm text-white ${
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
                    className='rounded-lg bg-blue-500 px-4 py-2 text-sm text-white'
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
