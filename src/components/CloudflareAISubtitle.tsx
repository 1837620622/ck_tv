'use client';

/**
 * =============================================================================
 * Cloudflare AI 字幕组件
 * =============================================================================
 * 使用 Cloudflare Workers AI Whisper 模型为视频生成字幕
 * 
 * 特点：
 * - 自动提取视频音频并生成字幕
 * - 支持中文、英语、日语等多种语言
 * - 免费额度：每天约 243 分钟
 * - 字幕样式美观，半透明背景
 * =============================================================================
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// -----------------------------------------------------------------------------
// 类型定义
// -----------------------------------------------------------------------------

interface CloudflareAISubtitleProps {
  /** 是否启用 */
  enabled: boolean;
  /** 视频 URL */
  videoUrl: string;
  /** 当前播放时间（秒） */
  currentTime: number;
  /** 语言代码（可选） */
  language?: string;
}

interface SubtitleCue {
  startTime: number;
  endTime: number;
  text: string;
}

interface SubtitleResponse {
  success: boolean;
  text: string;
  vtt: string;
  wordCount: number;
  quota: {
    used: number;
    remaining: number;
    limit: number;
  };
  error?: string;
  message?: string;
}

// -----------------------------------------------------------------------------
// 工具函数
// -----------------------------------------------------------------------------

/**
 * 解析 VTT 字幕文件
 */
function parseVTT(vttContent: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  if (!vttContent) return cues;

  const lines = vttContent.split('\n');
  let i = 0;

  // 跳过 WEBVTT 头
  while (i < lines.length && !lines[i].includes('-->')) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    // 查找时间行
    if (line.includes('-->')) {
      const [startStr, endStr] = line.split('-->').map(s => s.trim());
      const startTime = parseVTTTime(startStr);
      const endTime = parseVTTTime(endStr);

      // 收集字幕文本
      let text = '';
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        text += (text ? ' ' : '') + lines[i].trim();
        i++;
      }

      if (text) {
        cues.push({ startTime, endTime, text });
      }
    }
    i++;
  }

  return cues;
}

/**
 * 解析 VTT 时间格式 (HH:MM:SS.mmm)
 */
function parseVTTTime(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length === 3) {
    const [hours, minutes, secondsMs] = parts;
    const [seconds, ms] = secondsMs.split('.');
    return (
      parseInt(hours) * 3600 +
      parseInt(minutes) * 60 +
      parseInt(seconds) +
      (parseInt(ms || '0') / 1000)
    );
  }
  return 0;
}

// -----------------------------------------------------------------------------
// 组件
// -----------------------------------------------------------------------------

export default function CloudflareAISubtitle({
  enabled,
  videoUrl,
  currentTime,
  language = 'zh',
}: CloudflareAISubtitleProps) {
  // 字幕状态
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<string>('');

  // 防止重复请求
  const lastVideoUrl = useRef<string>('');
  const requestInProgress = useRef(false);

  // ---------------------------------------------------------------------------
  // 生成字幕
  // ---------------------------------------------------------------------------

  const generateSubtitle = useCallback(async () => {
    if (!videoUrl || requestInProgress.current) return;
    if (lastVideoUrl.current === videoUrl) return;

    requestInProgress.current = true;
    lastVideoUrl.current = videoUrl;
    setLoading(true);
    setError(null);
    setSubtitles([]);
    setCurrentSubtitle('');

    try {
      const response = await fetch('/api/subtitle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: videoUrl,
          language,
        }),
      });

      const data: SubtitleResponse = await response.json();

      if (!response.ok) {
        if (response.status === 429) {
          setError(`免费额度已用完，明天重置`);
          setQuotaInfo(data.message || '');
        } else {
          setError(data.error || '字幕生成失败');
        }
        return;
      }

      if (data.success && data.vtt) {
        const cues = parseVTT(data.vtt);
        setSubtitles(cues);
        setQuotaInfo(`剩余额度: ${Math.floor(data.quota.remaining)} neurons`);
      } else {
        setError('无法生成字幕');
      }
    } catch (err) {
      console.error('字幕生成错误:', err);
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
      requestInProgress.current = false;
    }
  }, [videoUrl, language]);

  // ---------------------------------------------------------------------------
  // 效果：启用时生成字幕
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (enabled && videoUrl) {
      generateSubtitle();
    }
  }, [enabled, videoUrl, generateSubtitle]);

  // ---------------------------------------------------------------------------
  // 效果：根据播放时间更新当前字幕
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!enabled || subtitles.length === 0) {
      setCurrentSubtitle('');
      return;
    }

    // 查找当前时间对应的字幕
    const cue = subtitles.find(
      (c) => currentTime >= c.startTime && currentTime <= c.endTime
    );

    setCurrentSubtitle(cue?.text || '');
  }, [enabled, currentTime, subtitles]);

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  if (!enabled) return null;

  return (
    <div className="absolute bottom-20 left-0 right-0 flex justify-center pointer-events-none z-50">
      <div className="max-w-[80%] text-center">
        {/* 加载状态 */}
        {loading && (
          <div className="bg-black/70 text-white px-4 py-2 rounded-lg text-sm">
            <span className="animate-pulse">🎙️ 正在生成 AI 字幕...</span>
          </div>
        )}

        {/* 错误状态 */}
        {error && !loading && (
          <div className="bg-red-900/70 text-white px-4 py-2 rounded-lg text-sm">
            ⚠️ {error}
            {quotaInfo && <div className="text-xs mt-1 opacity-80">{quotaInfo}</div>}
          </div>
        )}

        {/* 字幕显示 */}
        {currentSubtitle && !loading && !error && (
          <div
            className="bg-black/70 text-white px-4 py-2 rounded-lg"
            style={{
              fontSize: '20px',
              lineHeight: '1.4',
              textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
              fontWeight: 500,
            }}
          >
            {currentSubtitle}
          </div>
        )}

        {/* 等待字幕状态 */}
        {!loading && !error && subtitles.length > 0 && !currentSubtitle && (
          <div className="bg-black/50 text-white/60 px-3 py-1 rounded text-xs">
            AI 字幕已就绪
          </div>
        )}
      </div>
    </div>
  );
}
