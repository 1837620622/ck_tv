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

// 检测平台
const getPlatformInfo = () => {
  if (typeof window === 'undefined') return { isMac: false, isIOS: false, isChrome: false, isSafari: false };
  const ua = navigator.userAgent;
  const isMac = /Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isChrome = /Chrome/.test(ua) && !/Edg/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome/.test(ua);
  return { isMac, isIOS, isChrome, isSafari };
};

// DLNA 设备接口
interface DLNADevice {
  name: string;
  host: string;
  location: string;
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
  const [platform] = useState(getPlatformInfo);

  // DLNA 状态
  const [showDLNAPanel, setShowDLNAPanel] = useState(false);
  const [dlnaDevices, setDlnaDevices] = useState<DLNADevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DLNADevice | null>(null);
  const [isSearchingDLNA, setIsSearchingDLNA] = useState(false);
  const [isCastingDLNA, setIsCastingDLNA] = useState(false);

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

  // DLNA 设备发现
  const refreshDLNADevices = useCallback(async () => {
    setIsSearchingDLNA(true);
    setCastStatus('正在搜索局域网设备...');
    try {
      const response = await fetch('/api/dlna/refresh', { method: 'POST' });
      const data = await response.json();
      if (data.success && data.devices?.length > 0) {
        setDlnaDevices(data.devices);
        setCastStatus(`发现 ${data.devices.length} 个设备`);
      } else {
        setDlnaDevices([]);
        setCastStatus('未发现 DLNA 设备，请确保电视已开启 DLNA');
      }
    } catch {
      setCastStatus('搜索设备失败，请重试');
    } finally {
      setIsSearchingDLNA(false);
    }
  }, []);

  // DLNA 投屏
  const castToDLNA = useCallback(async () => {
    if (!selectedDevice) {
      setCastStatus('请先选择设备');
      return;
    }
    if (!videoUrl) {
      setCastStatus('请先播放视频');
      return;
    }
    setIsCastingDLNA(true);
    setCastStatus('正在投屏...');
    try {
      const response = await fetch('/api/dlna/cast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceHost: selectedDevice.location, // 使用完整的 location URL
          videoUrl: videoUrl,
          title: videoTitle || '视频播放',
        }),
      });
      const data = await response.json();
      if (data.success) {
        setCastStatus(data.message || '投屏成功！');
        setShowDLNAPanel(false);
      } else {
        setCastStatus(data.error || '投屏失败');
      }
    } catch {
      setCastStatus('投屏请求失败，请重试');
    } finally {
      setIsCastingDLNA(false);
    }
  }, [selectedDevice, videoUrl, videoTitle]);

  // 打开 DLNA 面板
  const openDLNAPanel = useCallback(() => {
    setShowDLNAPanel(true);
    refreshDLNADevices();
  }, [refreshDLNADevices]);

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
        else if (e.name === 'AbortError' || e.message?.includes('dismissed')) setCastStatus('已取消设备选择');
        else if (e.name === 'NotAllowedError') setCastStatus('已取消设备选择');
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
              {/* 投屏方式按钮组 */}
              <div className="grid grid-cols-2 gap-3">
                <button onClick={handleBrowserCast} disabled={isConnecting || isConnected}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${isConnected
                    ? 'bg-green-500/20 border-green-500 text-green-400'
                    : 'bg-gray-800/50 border-gray-700 hover:border-blue-500 hover:bg-blue-500/10 text-gray-300'
                    }`}>
                  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
                  </svg>
                  <span className="text-sm font-medium">{isConnected ? '已连接' : isConnecting ? '搜索中...' : 'Chromecast'}</span>
                </button>
                <button onClick={openDLNAPanel}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border bg-gray-800/50 border-gray-700 hover:border-purple-500 hover:bg-purple-500/10 text-gray-300 transition-all">
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
                  </svg>
                  <span className="text-sm font-medium">DLNA 投屏</span>
                </button>
                <button onClick={() => {
                  if (platform.isMac) {
                    setCastStatus('Mac 请使用：菜单栏「控制中心」→「屏幕镜像」→ 选择电视');
                  } else if (platform.isIOS) {
                    handleBrowserCast();
                  } else {
                    setCastStatus('AirPlay 仅支持苹果设备（iPhone/iPad/Mac）');
                  }
                }}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border bg-gray-800/50 border-gray-700 hover:border-gray-500 hover:bg-gray-500/10 text-gray-300 transition-all">
                  <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 3.5l6 8.5 6-8.5v1.5l-6 8.5-6-8.5zM6 11l6 8.5 6-8.5v1.5l-6 8.5-6-8.5z" />
                  </svg>
                  <span className="text-sm font-medium">AirPlay</span>
                </button>
                <button onClick={() => handleCopyLink(videoUrl)}
                  className="flex flex-col items-center gap-2 p-4 rounded-xl border bg-gray-800/50 border-gray-700 hover:border-green-500 hover:bg-green-500/10 text-gray-300 transition-all">
                  <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  <span className="text-sm font-medium">复制视频链接</span>
                </button>
              </div>
              {/* 平台说明 */}
              <div className="bg-gray-800/50 rounded-xl p-4 text-xs text-gray-400 space-y-1.5">
                {platform.isMac ? (
                  <>
                    <p className="text-orange-400 font-medium">📺 Mac 投屏到电视：</p>
                    <p>• <span className="text-green-400">Chromecast:</span> 需要 Chrome + Chromecast 设备</p>
                    <p>• <span className="text-green-400">屏幕镜像:</span> 菜单栏「控制中心」→「屏幕镜像」</p>
                    <p>• <span className="text-green-400">智能电视:</span> 复制链接用电视浏览器打开</p>
                  </>
                ) : platform.isIOS ? (
                  <>
                    <p className="text-blue-400 font-medium">📱 iOS 投屏：</p>
                    <p>• <span className="text-green-400">AirPlay:</span> 点击 Chromecast 按钮可选择 AirPlay 设备</p>
                    <p>• <span className="text-green-400">其他设备:</span> 使用扫码或复制链接</p>
                  </>
                ) : (
                  <>
                    <p className="text-blue-400 font-medium">📺 投屏说明：</p>
                    <p>• <span className="text-green-400">Chromecast:</span> Chrome 浏览器 + Chromecast 设备</p>
                    <p>• <span className="text-green-400">DLNA:</span> 需要安装投屏 App（乐播投屏等）</p>
                    <p>• <span className="text-green-400">智能电视:</span> 使用扫码或复制链接</p>
                  </>
                )}
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

      {/* DLNA 设备选择面板 */}
      {showDLNAPanel && (
        <div className="absolute inset-0 bg-[#1a1a1a] rounded-2xl flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
            <h2 className="text-lg font-bold text-white">DLNA 投屏</h2>
            <button onClick={() => setShowDLNAPanel(false)} className="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="flex-1 p-5 overflow-y-auto">
            <div className="flex justify-between items-center mb-3">
              <span className="text-sm text-gray-300">局域网设备</span>
              <button onClick={refreshDLNADevices} disabled={isSearchingDLNA}
                className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-white disabled:opacity-50">
                {isSearchingDLNA ? '搜索中...' : '🔄 刷新'}
              </button>
            </div>
            <div className="bg-gray-800/50 rounded-xl border border-gray-700 max-h-48 overflow-y-auto">
              {isSearchingDLNA ? (
                <div className="p-6 text-center text-gray-400 text-sm">
                  <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  正在搜索设备...
                </div>
              ) : dlnaDevices.length > 0 ? (
                dlnaDevices.map((device) => (
                  <div key={device.host} onClick={() => setSelectedDevice(device)}
                    className={`p-4 border-b border-gray-700 last:border-b-0 cursor-pointer hover:bg-gray-700/50 flex items-center gap-3 ${selectedDevice?.host === device.host ? 'bg-blue-900/30' : ''
                      }`}>
                    <span className="text-2xl">📺</span>
                    <div className="flex-1">
                      <div className="text-white text-sm font-medium">{device.name}</div>
                      <div className="text-gray-500 text-xs">{device.host}</div>
                    </div>
                    {selectedDevice?.host === device.host && <span className="text-green-400">✓</span>}
                  </div>
                ))
              ) : (
                <div className="p-6 text-center text-gray-400 text-sm">
                  <p>未发现设备</p>
                  <p className="text-xs mt-1">请确保电视已开启 DLNA</p>
                </div>
              )}
            </div>
          </div>
          <div className="p-5 border-t border-gray-800">
            <button onClick={castToDLNA} disabled={!selectedDevice || isCastingDLNA}
              className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              {isCastingDLNA ? '投屏中...' : '📺 投屏到选中设备'}
            </button>
            <p className="text-center text-xs text-gray-500 mt-3">找不到设备？请确保电视和手机在同一 WiFi</p>
          </div>
        </div>
      )}
    </div>
  );
}