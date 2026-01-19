# AI 字幕方案说明

## 概述

本项目实现了两种 AI 字幕方案：

| 方案 | 类型 | 费用 | 适用场景 |
|------|------|------|----------|
| Web Speech API | 客户端 | 免费 | 麦克风语音识别 |
| Cloudflare Workers AI | 服务端 | $0.00045/分钟 | 视频音频转字幕 |

## 方案一：Web Speech API (已实现)

### 特点

- 完全免费
- 浏览器端运行，无需服务器
- 实时语音识别
- 支持中文、英语、日语等

### 限制

- **只能识别麦克风输入**，无法直接识别视频音频
- 需要 Chrome/Edge 浏览器
- 需要网络连接（使用 Google 服务）

### 使用方法

1. 在播放器设置中打开 **AI实时字幕** 开关
2. 允许麦克风权限
3. 将设备麦克风靠近扬声器

### 相关文件

- `src/components/AISubtitle.tsx` - AI 字幕组件
- `src/lib/useWhisperSubtitle.ts` - Whisper Hook (预留)

## 方案二：Cloudflare Workers AI (服务端)

### 特点

- 使用 OpenAI Whisper 模型
- 支持 99 种语言
- 返回 VTT 格式字幕
- 包含词级时间戳

### 费用

- $0.00045 / 分钟音频
- 每天 10,000 次免费请求额度

### 配置要求

在 `.env` 文件中添加：

```env
CLOUDFLARE_ACCOUNT_ID=你的账户ID
CLOUDFLARE_API_TOKEN=你的API令牌
```

### API 使用

```bash
POST /api/subtitle
Content-Type: application/json

{
  "url": "视频或音频URL",
  "language": "zh"  // 可选
}
```

响应：

```json
{
  "success": true,
  "text": "转录的文本内容",
  "vtt": "WEBVTT\n\n00:00.000 --> 00:05.000\n字幕内容\n",
  "wordCount": 10
}
```

### 相关文件

- `src/app/api/subtitle/route.ts` - 字幕生成 API

## 播放器字幕设置

### 内嵌字幕

- 控制视频自带的字幕轨道显示/隐藏
- 在播放器设置中切换 **内嵌字幕** 开关

### AI实时字幕

- 使用麦克风进行实时语音识别
- 在播放器设置中切换 **AI实时字幕** 开关

## 推荐方案

| 场景 | 推荐方案 |
|------|----------|
| 个人使用，临时需要 | Web Speech API |
| 正式环境，高质量需求 | Cloudflare Workers AI |
| 离线使用 | 不支持（需要网络） |

## 后续优化方向

1. **字幕缓存**：将生成的字幕缓存到 D1 数据库
2. **外挂字幕源**：集成 OpenSubtitles 等字幕库
3. **字幕翻译**：支持实时字幕翻译

## 技术参考

- [Whisper.cpp](https://github.com/ggml-org/whisper.cpp) - 开源语音识别
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/whisper/) - Whisper 模型
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) - 浏览器语音识别
