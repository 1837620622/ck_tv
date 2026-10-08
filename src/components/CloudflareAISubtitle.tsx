'use client';

/**
 * =============================================================================
 * Cloudflare AI 字幕组件
 * =============================================================================
 *
 * 当前状态：功能开发中
 *
 * 技术限制：
 * - 跨域视频（HLS 流）无法使用 Web Audio API 捕获音频
 * - Cloudflare Workers 环境没有 ffmpeg 来提取音频
 * - 视频 URL 是 .m3u8 格式，无法直接下载
 *
 * 后续计划：
 * - 集成外部字幕源（如 OpenSubtitles）
 * - 支持用户上传音频文件
 * =============================================================================
 */

import { useEffect, useState } from 'react';

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

// -----------------------------------------------------------------------------
// 组件
// -----------------------------------------------------------------------------

export default function CloudflareAISubtitle({
  enabled,
}: CloudflareAISubtitleProps) {
  // 显示状态
  const [showMessage, setShowMessage] = useState(true);

  // 5秒后隐藏提示
  useEffect(() => {
    if (enabled) {
      setShowMessage(true);
      const timer = setTimeout(() => {
        setShowMessage(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className='absolute bottom-20 left-0 right-0 flex justify-center pointer-events-none z-50'>
      <div className='max-w-[80%] text-center'>
        {showMessage && (
          <div className='bg-yellow-900/80 text-white px-4 py-2 rounded-lg text-sm'>
            <div className='flex items-center gap-2'>
              <span>🔧</span>
              <span>AI 字幕功能开发中...</span>
            </div>
            <div className='text-xs mt-1 opacity-70'>
              跨域视频暂不支持音频提取
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
