/**
 * =============================================================================
 * 字幕生成 API
 * =============================================================================
 * 使用 Cloudflare Workers AI 的 Whisper 模型生成字幕
 * 
 * 特点：
 * - 免费额度：每天 10,000 次请求
 * - 支持中文、英语、日语等多种语言
 * - 返回 VTT 格式字幕，可直接用于 Artplayer
 * =============================================================================
 */

import { NextRequest, NextResponse } from 'next/server';

// -----------------------------------------------------------------------------
// 类型定义
// -----------------------------------------------------------------------------

interface WhisperResponse {
  text: string;
  word_count?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
  }>;
  vtt?: string;
}

interface SubtitleRequest {
  /** 音频/视频 URL */
  url: string;
  /** 语言代码 (可选，自动检测) */
  language?: string;
}

// -----------------------------------------------------------------------------
// 工具函数
// -----------------------------------------------------------------------------

/**
 * 从视频 URL 提取音频
 * 注意：这需要服务端有 ffmpeg 支持，或使用第三方服务
 */
async function extractAudioFromVideo(videoUrl: string): Promise<ArrayBuffer | null> {
  try {
    // 方案1: 直接下载视频的前几秒（用于测试）
    const response = await fetch(videoUrl, {
      headers: {
        'Range': 'bytes=0-5242880', // 只下载前 5MB
      },
    });

    if (!response.ok) {
      console.error('下载视频失败:', response.status);
      return null;
    }

    return await response.arrayBuffer();
  } catch (err) {
    console.error('提取音频失败:', err);
    return null;
  }
}

/**
 * 调用 Cloudflare Workers AI Whisper 模型
 */
async function transcribeWithWhisper(
  audioData: ArrayBuffer,
  language?: string
): Promise<WhisperResponse | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    console.error('缺少 Cloudflare 配置');
    return null;
  }

  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/openai/whisper`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: audioData,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Whisper API 错误:', error);
      return null;
    }

    const result = await response.json();
    return result.result as WhisperResponse;
  } catch (err) {
    console.error('调用 Whisper API 失败:', err);
    return null;
  }
}

/**
 * 生成 VTT 字幕格式
 */
function generateVTT(words: Array<{ word: string; start: number; end: number }>): string {
  if (!words || words.length === 0) return '';

  let vtt = 'WEBVTT\n\n';
  let lineStart = 0;
  let lineEnd = 0;
  let lineText = '';
  const maxLineLength = 40;
  const maxLineDuration = 5;

  words.forEach((word, index) => {
    if (lineText === '') {
      lineStart = word.start;
    }

    lineText += (lineText ? ' ' : '') + word.word;
    lineEnd = word.end;

    // 换行条件：文本太长、时间太长、或是最后一个词
    const shouldBreak =
      lineText.length >= maxLineLength ||
      (lineEnd - lineStart) >= maxLineDuration ||
      index === words.length - 1;

    if (shouldBreak && lineText.trim()) {
      const startTime = formatVTTTime(lineStart);
      const endTime = formatVTTTime(lineEnd);
      vtt += `${startTime} --> ${endTime}\n${lineText.trim()}\n\n`;
      lineText = '';
    }
  });

  return vtt;
}

/**
 * 格式化 VTT 时间
 */
function formatVTTTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

// -----------------------------------------------------------------------------
// API 路由处理
// -----------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as SubtitleRequest;
    const { url, language } = body;

    if (!url) {
      return NextResponse.json(
        { error: '缺少视频 URL' },
        { status: 400 }
      );
    }

    // 1. 提取音频
    const audioData = await extractAudioFromVideo(url);
    if (!audioData) {
      return NextResponse.json(
        { error: '无法提取音频' },
        { status: 500 }
      );
    }

    // 2. 调用 Whisper 转录
    const result = await transcribeWithWhisper(audioData, language);
    if (!result) {
      return NextResponse.json(
        { error: '转录失败' },
        { status: 500 }
      );
    }

    // 3. 生成 VTT 字幕
    let vtt = result.vtt;
    if (!vtt && result.words) {
      vtt = generateVTT(result.words);
    }

    return NextResponse.json({
      success: true,
      text: result.text,
      vtt: vtt || '',
      wordCount: result.word_count || 0,
    });

  } catch (err) {
    console.error('字幕生成失败:', err);
    return NextResponse.json(
      { error: '字幕生成失败' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    name: '字幕生成 API',
    description: '使用 Cloudflare Workers AI Whisper 模型生成字幕',
    usage: {
      method: 'POST',
      body: {
        url: '视频或音频 URL',
        language: '语言代码 (可选，如 zh, en, ja)',
      },
      response: {
        success: true,
        text: '转录文本',
        vtt: 'VTT 格式字幕',
        wordCount: '词数',
      },
    },
    pricing: '$0.00045 / 分钟',
    freeQuota: '每天 10,000 次请求',
  });
}
