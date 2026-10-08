# CKTV-传康播放器

<img src="public/logo.png" alt="CKTV" width="96">

影视聚合播放器。普通片、18+、AI 黄果分开。片源直接从上游播放，本站不存视频。

微信：1837620622（传康 Kk）
邮箱：2040168455@qq.com
咸鱼 / B 站：万能程序员

## 栏目

- 首页：热度最高、最新上线，以及剧集、动漫、综艺、纪录片、番组、哔哩
- 搜索：只搜普通片源
- 18+：只在本栏目浏览和搜索
- AI 黄果：单独栏目，封面在站内解密后显示
- 番组计划、哔哩哔哩：点开后按片名到普通片源里起播

## 本地运行

```bash
pnpm install
pnpm dev
```

开发地址是 `http://127.0.0.1:3000`。

## Cloudflare Pages

构建命令：

```bash
pnpm install --frozen-lockfile && pnpm run pages:build
```

输出目录按 `@cloudflare/next-on-pages` 的 `.vercel/output/static`。站点域名 `tv.chuankangkk.top`。

边缘缓存用 Cache API 和 `cf.cacheTtl`。不代理 HLS 分片，播放地址直接走片源 CDN。

## 配置

片源写在 `config.json`。`src/lib/runtime.ts` 由 `pnpm gen:runtime` 生成，不提交。

当前存储是浏览器本地存储，没有管理员后台。
