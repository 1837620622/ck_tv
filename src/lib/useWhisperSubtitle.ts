/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * =============================================================================
 * Whisper.cpp WebAssembly 实时字幕 Hook
 * =============================================================================
 * 基于 Whisper.cpp 的 WebAssembly 版本实现浏览器端实时语音识别
 * 特点：
 * - 完全免费，开源
 * - 浏览器端运行，无需服务器
 * - 支持中文、日语、英语等 99 种语言
 * - OpenAI Whisper 模型，业界领先准确率
 * =============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';

// -----------------------------------------------------------------------------
// 类型定义
// -----------------------------------------------------------------------------

/** Whisper 模型类型 */
type WhisperModel = 'tiny' | 'base' | 'small';

/** Whisper 模型信息 */
interface ModelInfo {
  name: string;
  size: string;
  url: string;
}

/** 字幕段落 */
interface SubtitleSegment {
  id: number;
  text: string;
  startTime: number;
  endTime: number;
}

/** Hook 返回值 */
interface UseWhisperSubtitleReturn {
  /** 是否正在加载模型 */
  isModelLoading: boolean;
  /** 模型加载进度 (0-100) */
  modelLoadProgress: number;
  /** 是否正在录音/识别 */
  isRecording: boolean;
  /** 当前字幕文本 */
  currentSubtitle: string;
  /** 字幕历史记录 */
  subtitleHistory: SubtitleSegment[];
  /** 错误信息 */
  error: string | null;
  /** 是否已初始化 */
  isInitialized: boolean;
  /** 开始录音识别 */
  startRecording: () => Promise<void>;
  /** 停止录音识别 */
  stopRecording: () => void;
  /** 加载模型 */
  loadModel: (model?: WhisperModel) => Promise<boolean>;
  /** 清除字幕 */
  clearSubtitles: () => void;
}

// -----------------------------------------------------------------------------
// 常量配置
// -----------------------------------------------------------------------------

/** 采样率 (Whisper 要求 16kHz) */
const SAMPLE_RATE = 16000;

/** 音频采集间隔 (毫秒) */
const AUDIO_INTERVAL_MS = 3000;

/** 模型配置 */
const MODELS: Record<WhisperModel, ModelInfo> = {
  tiny: {
    name: 'Tiny (量化版)',
    size: '31MB',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  },
  base: {
    name: 'Base (量化版)',
    size: '57MB',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  },
  small: {
    name: 'Small (量化版)',
    size: '151MB',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  },
};

/** IndexedDB 数据库名称 */
const DB_NAME = 'whisper-models';
const DB_STORE = 'models';
const DB_VERSION = 1;

// -----------------------------------------------------------------------------
// IndexedDB 工具函数
// -----------------------------------------------------------------------------

/** 打开 IndexedDB 数据库 */
const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
  });
};

/** 从 IndexedDB 获取模型 */
const getModelFromDB = async (modelName: string): Promise<ArrayBuffer | null> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readonly');
      const store = transaction.objectStore(DB_STORE);
      const request = store.get(modelName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  } catch {
    return null;
  }
};

/** 保存模型到 IndexedDB */
const saveModelToDB = async (modelName: string, data: ArrayBuffer): Promise<void> => {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readwrite');
      const store = transaction.objectStore(DB_STORE);
      const request = store.put(data, modelName);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (err) {
    console.error('保存模型到 IndexedDB 失败:', err);
  }
};

// -----------------------------------------------------------------------------
// Whisper WASM 模块加载
// -----------------------------------------------------------------------------

/** 全局 Whisper 模块引用 */
let whisperModule: any = null;
let whisperInstance: any = null;

/** 加载 Whisper WASM 模块 */
const loadWhisperModule = async (): Promise<any> => {
  if (whisperModule) return whisperModule;

  // 动态加载 Whisper WASM 模块
  // 注意：需要将 whisper.cpp 的 WASM 编译产物放到 public 目录
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/whisper/whisper.js';
    script.onload = () => {
      // @ts-ignore
      if (window.createWhisperModule) {
        // @ts-ignore
        window.createWhisperModule().then((module: any) => {
          whisperModule = module;
          resolve(module);
        });
      } else {
        reject(new Error('Whisper 模块加载失败'));
      }
    };
    script.onerror = () => reject(new Error('无法加载 Whisper WASM 脚本'));
    document.head.appendChild(script);
  });
};

// -----------------------------------------------------------------------------
// 主 Hook
// -----------------------------------------------------------------------------

export function useWhisperSubtitle(): UseWhisperSubtitleReturn {
  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [modelLoadProgress, setModelLoadProgress] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [currentSubtitle, setCurrentSubtitle] = useState('');
  const [subtitleHistory, setSubtitleHistory] = useState<SubtitleSegment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioBufferRef = useRef<Float32Array[]>([]);
  const segmentIdRef = useRef(0);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------------------------------------------------------------------
  // 清理函数
  // ---------------------------------------------------------------------------
  const cleanup = useCallback(() => {
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    audioBufferRef.current = [];
  }, []);

  // ---------------------------------------------------------------------------
  // 组件卸载时清理
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // ---------------------------------------------------------------------------
  // 加载模型
  // ---------------------------------------------------------------------------
  const loadModel = useCallback(async (model: WhisperModel = 'tiny'): Promise<boolean> => {
    if (isModelLoading) return false;

    setIsModelLoading(true);
    setModelLoadProgress(0);
    setError(null);

    try {
      // 1. 检查 IndexedDB 缓存
      console.log(`检查模型缓存: ${model}`);
      let modelData = await getModelFromDB(model);

      if (!modelData) {
        // 2. 下载模型
        console.log(`下载模型: ${MODELS[model].url}`);
        const response = await fetch(MODELS[model].url);

        if (!response.ok) {
          throw new Error(`下载模型失败: ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        const reader = response.body?.getReader();
        if (!reader) throw new Error('无法读取响应');

        const chunks: Uint8Array[] = [];
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          received += value.length;

          if (total > 0) {
            setModelLoadProgress(Math.round((received / total) * 100));
          }
        }

        // 合并数据
        modelData = new Uint8Array(received).buffer;
        let offset = 0;
        for (const chunk of chunks) {
          new Uint8Array(modelData).set(chunk, offset);
          offset += chunk.length;
        }

        // 3. 缓存到 IndexedDB
        await saveModelToDB(model, modelData);
        console.log(`模型已缓存到 IndexedDB: ${model}`);
      } else {
        console.log(`从缓存加载模型: ${model}`);
        setModelLoadProgress(100);
      }

      // 4. 加载 WASM 模块并初始化
      console.log('加载 Whisper WASM 模块...');
      const module = await loadWhisperModule();

      // 初始化 Whisper 实例
      if (whisperInstance) {
        module.free(whisperInstance);
      }

      whisperInstance = module.init(new Uint8Array(modelData));

      if (!whisperInstance) {
        throw new Error('Whisper 初始化失败');
      }

      setIsInitialized(true);
      console.log('Whisper 初始化成功');
      return true;

    } catch (err) {
      const message = err instanceof Error ? err.message : '加载模型失败';
      console.error('加载模型失败:', err);
      setError(message);
      return false;
    } finally {
      setIsModelLoading(false);
    }
  }, [isModelLoading]);

  // ---------------------------------------------------------------------------
  // 处理音频数据
  // ---------------------------------------------------------------------------
  const processAudio = useCallback(async (audioData: Float32Array) => {
    if (!whisperModule || !whisperInstance) {
      console.warn('Whisper 未初始化');
      return;
    }

    try {
      // 设置音频数据
      whisperModule.set_audio(whisperInstance, audioData);

      // 获取转录结果
      const result = whisperModule.get_transcribed();

      if (result && result.trim()) {
        const segment: SubtitleSegment = {
          id: ++segmentIdRef.current,
          text: result.trim(),
          startTime: Date.now() - AUDIO_INTERVAL_MS,
          endTime: Date.now(),
        };

        setCurrentSubtitle(result.trim());
        setSubtitleHistory((prev: SubtitleSegment[]) => {
          // 保留最近 20 条记录
          const newHistory = [...prev, segment];
          if (newHistory.length > 20) {
            newHistory.shift();
          }
          return newHistory;
        });
      }
    } catch (err) {
      console.error('音频处理失败:', err);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // 开始录音
  // ---------------------------------------------------------------------------
  const startRecording = useCallback(async () => {
    if (isRecording) return;
    if (!isInitialized) {
      setError('请先加载模型');
      return;
    }

    setError(null);

    try {
      // 请求麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      streamRef.current = stream;

      // 创建 AudioContext
      audioContextRef.current = new AudioContext({
        sampleRate: SAMPLE_RATE,
      });

      // 创建 MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus',
      });
      mediaRecorderRef.current = mediaRecorder;

      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);

          // 处理累积的音频数据
          const blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' });
          const arrayBuffer = await blob.arrayBuffer();

          if (audioContextRef.current) {
            try {
              const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
              const channelData = audioBuffer.getChannelData(0);

              // 重采样到 16kHz (如果需要)
              let samples = channelData;
              if (audioBuffer.sampleRate !== SAMPLE_RATE) {
                const ratio = audioBuffer.sampleRate / SAMPLE_RATE;
                const newLength = Math.floor(channelData.length / ratio);
                samples = new Float32Array(newLength);
                for (let i = 0; i < newLength; i++) {
                  samples[i] = channelData[Math.floor(i * ratio)];
                }
              }

              await processAudio(samples);
            } catch (err) {
              console.warn('音频解码失败:', err);
            }
          }
        }
      };

      mediaRecorder.onstop = () => {
        chunks.length = 0;
      };

      // 开始录音，每隔 AUDIO_INTERVAL_MS 触发一次 dataavailable
      mediaRecorder.start(AUDIO_INTERVAL_MS);
      setIsRecording(true);

      console.log('开始录音识别');
    } catch (err) {
      const message = err instanceof Error ? err.message : '无法获取麦克风权限';
      console.error('开始录音失败:', err);
      setError(message);
      cleanup();
    }
  }, [isRecording, isInitialized, processAudio, cleanup]);

  // ---------------------------------------------------------------------------
  // 停止录音
  // ---------------------------------------------------------------------------
  const stopRecording = useCallback(() => {
    cleanup();
    setIsRecording(false);
    console.log('停止录音识别');
  }, [cleanup]);

  // ---------------------------------------------------------------------------
  // 清除字幕
  // ---------------------------------------------------------------------------
  const clearSubtitles = useCallback(() => {
    setCurrentSubtitle('');
    setSubtitleHistory([]);
    segmentIdRef.current = 0;
  }, []);

  // ---------------------------------------------------------------------------
  // 返回
  // ---------------------------------------------------------------------------
  return {
    isModelLoading,
    modelLoadProgress,
    isRecording,
    currentSubtitle,
    subtitleHistory,
    error,
    isInitialized,
    startRecording,
    stopRecording,
    loadModel,
    clearSubtitles,
  };
}

export type { WhisperModel, SubtitleSegment, UseWhisperSubtitleReturn };
