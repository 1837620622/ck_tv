# AI 字幕方案说明

## 概述

本项目实现了两种字幕方案：

| 方案 | 类型 | 费用 | 适用场景 |
|------|------|------|----------|
| 内嵌字幕 | 播放器原生 | 免费 | 视频自带字幕 |
| Cloudflare Workers AI | 服务端 | 免费额度 243分钟/天 | AI 生成字幕 |

## 方案一：内嵌字幕

### 特点

- 使用视频源自带的字幕轨道
- 无需额外配置
- 支持多语言切换

### 使用方法

1. 在播放器设置中打开 **内嵌字幕** 开关
2. 如果视频源有字幕，会自动显示

### 相关文件

- `src/app/play/page.tsx` - 播放器字幕控制逻辑

## 方案二：Cloudflare Workers AI (服务端)

### 特点

- 使用 OpenAI Whisper 模型
- 支持 99 种语言
- 返回 VTT 格式字幕
- 包含词级时间戳

### 费用

- 每天 **10,000 Neurons 免费额度**（约 243 分钟音频）
- 超出免费额度自动停用，不产生费用
- 付费价格：$0.0005 / 分钟

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

在播放器设置面板中可以控制：

- **内嵌字幕**：显示/隐藏视频自带的字幕轨道

## 后续优化方向

1. **字幕缓存**：将生成的字幕缓存到 D1 数据库
2. **外挂字幕源**：集成 OpenSubtitles 等字幕库
3. **字幕翻译**：支持实时字幕翻译

## 技术参考

- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/whisper/) - Whisper 模型
