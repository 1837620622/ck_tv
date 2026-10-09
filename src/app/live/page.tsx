'use client';

import Hls from 'hls.js';
import { Radio } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { LIVE_CHANNELS, LIVE_GROUPS, LiveChannel, LiveGroup } from '@/lib/live';
import { qualityText } from '@/lib/playlist';

import { choiceClass } from '@/components/ChoiceRow';
import ChoiceRow from '@/components/ChoiceRow';
import PageLayout from '@/components/PageLayout';

type Phase = 'idle' | 'loading' | 'ready' | 'error';

export default function LivePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const tokenRef = useRef(0);
  const clockRef = useRef(0);
  const [group, setGroup] = useState<LiveGroup>('cctv');
  const [current, setCurrent] = useState<LiveChannel | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [line, setLine] = useState('');
  const [picture, setPicture] = useState('');
  const [delay, setDelay] = useState<number | null>(null);

  const playChannel = useCallback((channel: LiveChannel) => {
    const token = ++tokenRef.current;
    window.clearInterval(clockRef.current);
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setPicture('');
    setDelay(null);
    const video = videoRef.current;
    if (video) {
      video.removeAttribute('src');
      video.load();
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
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          node.removeEventListener('loadeddata', onMedia);
          node.removeEventListener('playing', onMedia);
          node.removeEventListener('error', onFail);
          if (token !== tokenRef.current) {
            hls?.destroy();
            resolve(false);
            return;
          }
          if (ok) {
            hlsRef.current = hls;
            node.play().catch(() => undefined);
            resolve(true);
            return;
          }
          window.clearInterval(clockRef.current);
          hls?.destroy();
          node.removeAttribute('src');
          node.load();
          resolve(false);
        };
        // 清单能打开不算成功。画面要等到有宽度，声音要等到缓冲开始。
        const onMedia = () => {
          if (audio ? node.readyState >= 2 : node.videoWidth > 0) done(true);
        };
        const onFail = () => done(false);
        timer = window.setTimeout(() => done(false), 9000);
        node.addEventListener('loadeddata', onMedia);
        node.addEventListener('playing', onMedia);
        node.addEventListener('error', onFail);
        if (node.canPlayType('application/vnd.apple.mpegurl')) {
          node.src = url;
          return;
        }
        if (!Hls.isSupported()) {
          done(false);
          return;
        }
        // 先锁最高档。直播只留约两个分片的缓冲，落后就小幅追。
        hls = new Hls({
          enableWorker: true,
          capLevelToPlayerSize: false,
          abrEwmaDefaultEstimate: 8_000_000,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 4,
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
          const height = level?.height || videoRef.current?.videoHeight || 0;
          if (height) setPicture(qualityText(height));
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
          hls.currentLevel = hls.levels.length - 1;
          remember();
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, remember);
        hls.on(Hls.Events.FRAG_BUFFERED, remember);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return;
          if (hls.currentLevel > 0) {
            hls.currentLevel -= 1;
            hls.startLoad();
            return;
          }
          // 已经出画就在原档追，不再切走。没出画才换下一条地址。
          if (settled) {
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
              hls.recoverMediaError();
            else hls.startLoad();
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

  useEffect(() => {
    const first = LIVE_CHANNELS.find((item) => item.id === 'cctv1');
    if (first) playChannel(first);
    return () => {
      tokenRef.current += 1;
      window.clearInterval(clockRef.current);
      hlsRef.current?.destroy();
    };
  }, [playChannel]);

  const visible = LIVE_CHANNELS.filter((item) => item.group === group);

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
            onChange={(value) => setGroup(value as LiveGroup)}
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
                className='aspect-video w-full'
              />
            </div>
            <div className='mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300'>
              <span>{current?.name || '选一个频道'}</span>
              {picture ? <span>{picture}</span> : null}
              {delay != null ? <span>延迟 {delay} 秒</span> : null}
              {line ? (
                <span
                  className={
                    phase === 'error' ? 'text-red-700' : 'text-gray-500'
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
            <div className='flex flex-wrap gap-1.5'>
              {visible.map((item) => (
                <button
                  key={item.id}
                  type='button'
                  className={choiceClass(current?.id === item.id, true)}
                  onClick={() => playChannel(item)}
                >
                  {item.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </PageLayout>
  );
}
