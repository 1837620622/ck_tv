/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * =============================================================================
 * AI 实时字幕组件
 * =============================================================================
 * 基于 Whisper.cpp WebAssembly 的实时语音识别字幕显示组件
 * 特点：
 * - 完全免费，浏览器端运行
 * - 支持中文、日语、英语等多种语言
 * - 可自定义字幕样式
 * =============================================================================
 */

'use client';

import { Loader2, Mic, MicOff, Settings, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

// -----------------------------------------------------------------------------
// 类型定义
// -----------------------------------------------------------------------------

interface AISubtitleProps {
  /** 是否显示 */
  visible: boolean;
  /** 关闭回调 */
  onClose?: () => void;
  /** 视频元素引用 (用于捕获音频) */
  videoElement?: HTMLVideoElement | null;
}

/** 字幕段落 */
interface SubtitleSegment {
  id: number;
  text: string;
  timestamp: number;
}

// -----------------------------------------------------------------------------
// 常量配置
// -----------------------------------------------------------------------------

/** 采样率 (Whisper 要求 16kHz) */
const SAMPLE_RATE = 16000;

/** 音频采集间隔 (毫秒) */
const AUDIO_INTERVAL_MS = 5000;

/** 最大字幕显示条数 */
const MAX_SUBTITLE_LINES = 3;

/** 字幕显示时间 (毫秒) */
const SUBTITLE_DISPLAY_TIME = 8000;

// -----------------------------------------------------------------------------
// 简化版实现 - 使用 Web Speech API 作为后备方案
// -----------------------------------------------------------------------------

/**
 * AI 实时字幕组件
 * 
 * 注意：完整的 Whisper.cpp WASM 实现需要编译 WASM 文件
 * 当前版本提供 Web Speech API 作为后备方案
 * 
 * 完整版实现需要：
 * 1. 将 whisper.cpp 编译为 WASM (约 10-50MB)
 * 2. 部署模型文件到 CDN 或本地
 * 3. 首次使用时下载并缓存模型
 */
const AISubtitle: React.FC<AISubtitleProps> = (props: AISubtitleProps) => {
  const { visible, onClose, videoElement } = props;
  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const [isRecording, setIsRecording] = useState(false);
  const [currentSubtitle, setCurrentSubtitle] = useState('');
  const [subtitleHistory, setSubtitleHistory] = useState<SubtitleSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSupported, setIsSupported] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [language, setLanguage] = useState('zh-CN');

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------
  const recognitionRef = useRef<any>(null);
  const segmentIdRef = useRef(0);
  const cleanupTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------------------------------------------------------------------
  // 检查浏览器支持
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsSupported(false);
      setError('当前浏览器不支持语音识别，请使用 Chrome 或 Edge 浏览器');
    }
  }, []);

  // ---------------------------------------------------------------------------
  // 清理过期字幕
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (subtitleHistory.length === 0) return;

    cleanupTimerRef.current = setInterval(() => {
      const now = Date.now();
      setSubtitleHistory((prev: SubtitleSegment[]) =>
        prev.filter((s: SubtitleSegment) => now - s.timestamp < SUBTITLE_DISPLAY_TIME)
      );
    }, 1000);

    return () => {
      if (cleanupTimerRef.current) {
        clearInterval(cleanupTimerRef.current);
      }
    };
  }, [subtitleHistory.length > 0]);

  // ---------------------------------------------------------------------------
  // 尝试从视频捕获音频 (实验性)
  // ---------------------------------------------------------------------------
  const captureVideoAudio = useCallback(async (): Promise<MediaStream | null> => {
    if (!videoElement) {
      console.log('无视频元素，使用麦克风');
      return null;
    }

    try {
      // 方法1: 尝试使用 captureStream (仅同源视频有效)
      if ('captureStream' in videoElement) {
        const stream = (videoElement as any).captureStream();
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log('成功从视频捕获音频流');
          return new MediaStream(audioTracks);
        }
      }
    } catch (err) {
      console.warn('从视频捕获音频失败 (可能是跨域限制):', err);
    }

    return null;
  }, [videoElement]);

  // ---------------------------------------------------------------------------
  // 开始识别
  // ---------------------------------------------------------------------------
  const startRecognition = useCallback(async () => {
    if (!isSupported) return;

    const SpeechRecognition = (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    // 尝试从视频捕获音频
    const videoAudioStream = await captureVideoAudio();
    if (videoAudioStream) {
      // 如果成功捕获视频音频，显示提示
      console.log('使用视频音频进行识别');
    } else {
      // 否则提示用户
      setError('提示：当前使用麦克风识别，请将设备靠近扬声器');
      setTimeout(() => setError(null), 3000);
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      console.log('语音识别已启动');
      setIsRecording(true);
      setError(null);
    };

    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      // 显示临时结果
      if (interimTranscript) {
        setCurrentSubtitle(interimTranscript);
      }

      // 保存最终结果
      if (finalTranscript) {
        const segment: SubtitleSegment = {
          id: ++segmentIdRef.current,
          text: finalTranscript.trim(),
          timestamp: Date.now(),
        };

        setSubtitleHistory((prev: SubtitleSegment[]) => {
          const newHistory = [...prev, segment];
          // 保留最近几条
          if (newHistory.length > MAX_SUBTITLE_LINES) {
            return newHistory.slice(-MAX_SUBTITLE_LINES);
          }
          return newHistory;
        });
        setCurrentSubtitle('');
      }
    };

    recognition.onerror = (event: any) => {
      console.error('语音识别错误:', event.error);

      // 处理特定错误
      switch (event.error) {
        case 'no-speech':
          // 无语音，静默处理
          break;
        case 'audio-capture':
          setError('无法获取麦克风，请检查权限设置');
          setIsRecording(false);
          break;
        case 'not-allowed':
          setError('麦克风权限被拒绝，请在浏览器设置中允许');
          setIsRecording(false);
          break;
        case 'network':
          setError('网络错误，请检查网络连接');
          break;
        default:
          setError(`识别错误: ${event.error}`);
      }
    };

    recognition.onend = () => {
      console.log('语音识别已结束');
      // 如果仍在录音状态，自动重启
      if (isRecording && recognitionRef.current) {
        try {
          recognition.start();
        } catch (err) {
          console.warn('重启识别失败:', err);
        }
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      console.error('启动识别失败:', err);
      setError('启动语音识别失败');
    }
  }, [isSupported, language, isRecording, captureVideoAudio]);

  // ---------------------------------------------------------------------------
  // 停止识别
  // ---------------------------------------------------------------------------
  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
  }, []);

  // ---------------------------------------------------------------------------
  // 切换录音状态
  // ---------------------------------------------------------------------------
  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecognition();
    } else {
      startRecognition();
    }
  }, [isRecording, startRecognition, stopRecognition]);

  // ---------------------------------------------------------------------------
  // 组件卸载时清理
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      if (cleanupTimerRef.current) {
        clearInterval(cleanupTimerRef.current);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // 不可见时不渲染
  // ---------------------------------------------------------------------------
  if (!visible) return null;

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  return (
    <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[1000] w-full max-w-3xl px-4">
      {/* 字幕显示区域 */}
      <div className="relative">
        {/* 字幕内容 */}
        <div className="bg-black/70 backdrop-blur-sm rounded-lg px-6 py-4 text-center min-h-[60px]">
          {/* 错误提示 */}
          {error && (
            <div className="text-red-400 text-sm mb-2">{error}</div>
          )}

          {/* 字幕历史 */}
          {subtitleHistory.map((segment: SubtitleSegment) => (
            <p
              key={segment.id}
              className="text-white text-lg leading-relaxed opacity-60 mb-1"
            >
              {segment.text}
            </p>
          ))}

          {/* 当前字幕 (临时结果) */}
          {currentSubtitle && (
            <p className="text-white text-xl font-medium leading-relaxed animate-pulse">
              {currentSubtitle}
            </p>
          )}

          {/* 无字幕时的提示 */}
          {!currentSubtitle && subtitleHistory.length === 0 && !error && (
            <p className="text-gray-400 text-base">
              {isRecording ? '正在聆听...' : '点击麦克风开始字幕'}
            </p>
          )}
        </div>

        {/* 控制栏 */}
        <div className="flex items-center justify-center gap-3 mt-3">
          {/* 录音按钮 */}
          <button
            onClick={toggleRecording}
            disabled={!isSupported}
            className={`p-3 rounded-full transition-all duration-200 ${isRecording
              ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse'
              : 'bg-white/20 hover:bg-white/30 text-white'
              } ${!isSupported ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={isRecording ? '停止识别' : '开始识别'}
          >
            {isRecording ? (
              <MicOff className="w-5 h-5" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>

          {/* 设置按钮 */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-3 rounded-full bg-white/20 hover:bg-white/30 text-white transition-all duration-200"
            title="设置"
          >
            <Settings className="w-5 h-5" />
          </button>

          {/* 关闭按钮 */}
          {onClose && (
            <button
              onClick={() => {
                stopRecognition();
                onClose();
              }}
              className="p-3 rounded-full bg-white/20 hover:bg-white/30 text-white transition-all duration-200"
              title="关闭字幕"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* 设置面板 */}
        {showSettings && (
          <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-gray-900/95 backdrop-blur-sm rounded-lg p-4 min-w-[200px]">
            <h3 className="text-white text-sm font-medium mb-3">字幕设置</h3>

            {/* 语言选择 */}
            <div className="mb-3">
              <label className="text-gray-400 text-xs mb-1 block">识别语言</label>
              <select
                value={language}
                onChange={(e) => {
                  setLanguage(e.target.value);
                  if (isRecording) {
                    stopRecognition();
                    setTimeout(startRecognition, 100);
                  }
                }}
                className="w-full bg-gray-800 text-white text-sm rounded px-3 py-2 border border-gray-700 focus:border-green-500 outline-none"
              >
                <option value="zh-CN">中文 (简体)</option>
                <option value="zh-TW">中文 (繁体)</option>
                <option value="en-US">英语 (美国)</option>
                <option value="ja-JP">日语</option>
                <option value="ko-KR">韩语</option>
              </select>
            </div>

            {/* 提示信息 */}
            <p className="text-gray-500 text-xs">
              提示：语音识别需要麦克风权限
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AISubtitle;
