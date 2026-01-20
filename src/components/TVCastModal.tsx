'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';

interface TVCastModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoUrl: string;
  videoTitle: string;
  currentTime?: number;
}

export default function TVCastModal({
  isOpen,
  onClose,
  videoUrl,
  videoTitle,
}: TVCastModalProps) {
  const [copied, setCopied] = useState(false);
  const [castStatus, setCastStatus] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'cast' | 'qrcode' | 'link'>('cast');

  const getCurrentPageUrl = useCallback(() => {
    if (typeof window === 'undefined') return '';
    return window.location.href;
  }, []);

  const handleCopyLink = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCastStatus('链接已复制');
      setTimeout(() => { setCopied(false); setCastStatus(''); }, 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setCastStatus('链接已复制');
      setTimeout(() => { setCopied(false); setCastStatus(''); }, 2000);
    }
  }, []);

  const handleBrowserCast = useCallback(async () => {
    const video = document.querySelector('video');
    if (!video) { setCastStatus('请先播放视频'); return; }
    if (video.remote) {
      try {
        setIsConnecting(true);
        setCastStatus('正在搜索投屏设备...');

        // 根据 W3C 规范：监听连接状态变化
        video.remote.onconnecting = () => {
          setIsConnecting(true);
          setCastStatus('正在连接...');
        };
        video.remote.onconnect = () => {
          setIsConnecting(false);
          setIsConnected(true);
          setCastStatus('已成功连接到投屏设备');
        };
        video.remote.ondisconnect = () => {
          setIsConnecting(false);
          setIsConnected(false);
          setCastStatus('已断开投屏连接');
        };

        // 调用 prompt() 弹出设备选择器
        await video.remote.prompt();

        // 检查当前状态
        if (video.remote.state === 'connected') {
          setIsConnected(true);
          setCastStatus('已成功连接到投屏设备');
        } else if (video.remote.state === 'connecting') {
          setCastStatus('正在连接...');
        }
        setIsConnecting(false);
      } catch (err: unknown) {
        const e = err as Error;
        setIsConnecting(false);
        if (e.name === 'NotFoundError') setCastStatus('未找到投屏设备，请确保设备在同一网络');
        else if (e.name === 'NotSupportedError') setCastStatus('当前浏览器不支持投屏功能');
        else if (e.name === 'InvalidStateError') setCastStatus('请先播放视频再进行投屏');
        else if (e.name === 'AbortError') setCastStatus('已取消设备选择');
        else setCastStatus('投屏失败: ' + e.message);
      }
    } else {
      setCastStatus('当前浏览器不支持投屏，请使用扫码或复制链接方式');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setCastStatus('');
      setCopied(false);
      setIsConnecting(false);
      setIsConnected(false);
      setActiveTab('cast');
    }
  }, [isOpen]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && isOpen) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  const pageUrl = getCurrentPageUrl();

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-[#1a1a1a] rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white">电视投屏</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
            <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex border-b border-gray-800">
          {(['cast', 'qrcode', 'link'] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`flex-1 py-3 text-sm font-medium ${activeTab === tab ? 'text-green-400 border-b-2 border-green-400' : 'text-gray-400'}`}>
              {tab === 'cast' ? '投屏' : tab === 'qrcode' ? '扫码' : '链接'}
            </button>
          ))}
        </div>
        <div className="p-5">
          {activeTab === 'cast' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400 text-center">
                {isConnected ? '已连接投屏设备' : '点击下方按钮搜索投屏设备'}
              </p>
              <button onClick={handleBrowserCast} disabled={isConnecting || isConnected}
                className={`w-full py-4 rounded-xl font-medium transition-all ${isConnected
                    ? 'bg-green-500 text-white cursor-default'
                    : 'bg-green-600 hover:bg-green-700 text-white disabled:opacity-50'
                  }`}>
                {isConnecting ? (
                  <span className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    搜索中...
                  </span>
                ) : isConnected ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    已连接
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                    </svg>
                    搜索投屏设备
                  </span>
                )}
              </button>
              <div className="bg-gray-800/50 rounded-xl p-4 text-xs text-gray-400 space-y-1">
                <p><span className="text-green-400">Chromecast:</span> 需要 Chrome 浏览器 + Chromecast 设备</p>
                <p><span className="text-green-400">AirPlay:</span> 需要 Safari 浏览器 + Apple TV</p>
                <p><span className="text-green-400">其他设备:</span> 请使用扫码或复制链接方式</p>
              </div>
            </div>
          )}
          {activeTab === 'qrcode' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400 text-center">用电视浏览器扫码观看</p>
              <div className="flex justify-center">
                <div className="bg-white p-4 rounded-2xl">
                  <QRCodeSVG value={pageUrl} size={180} level="M" />
                </div>
              </div>
            </div>
          )}
          {activeTab === 'link' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-400 text-center">复制链接到电视浏览器打开</p>
              <div className="space-y-2">
                <label className="text-xs text-gray-500">页面链接</label>
                <div className="flex gap-2">
                  <input value={pageUrl} readOnly className="flex-1 bg-gray-800 text-gray-300 text-sm px-3 py-2 rounded-lg truncate" />
                  <button onClick={() => handleCopyLink(pageUrl)} className={`px-4 py-2 rounded-lg text-sm ${copied ? 'bg-green-500' : 'bg-blue-500'} text-white`}>
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-xs text-gray-500">视频链接</label>
                <div className="flex gap-2">
                  <input value={videoUrl} readOnly className="flex-1 bg-gray-800 text-gray-300 text-sm px-3 py-2 rounded-lg truncate" />
                  <button onClick={() => handleCopyLink(videoUrl)} className="px-4 py-2 rounded-lg text-sm bg-blue-500 text-white">复制</button>
                </div>
              </div>
            </div>
          )}
        </div>
        {castStatus && <div className="mx-5 mb-5 px-4 py-3 rounded-xl bg-orange-500/20 text-orange-400 text-center text-sm">{castStatus}</div>}
        <div className="px-5 pb-5"><p className="text-center text-xs text-gray-500">确保手机和电视在同一 WiFi 网络</p></div>
      </div>
    </div>
  );
}