import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';


const at = (path) => fileURLToPath(new URL(path, import.meta.url));


// 界面是纯静态页面（多页面），不需要前端框架。Tauri 直接加载构建产物。
export default defineConfig({
  root: at('./src'),
  base: './',
  publicDir: false,
  build: {
    outDir: at('./dist'),
    emptyOutDir: true,
    target: ['es2020', 'safari14', 'chrome100', 'firefox100'],
    rollupOptions: {
      input: {
        index: at('./src/index.html'),
        offline: at('./src/offline.html'),
        updates: at('./src/updates.html'),
        downloads: at('./src/downloads.html'),
      },
    },
  },
  css: {
    // 客户端是纯手写 CSS，不用站点的 Tailwind/PostCSS 配置；显式清空，避免 Vite 向上找到根目录的 postcss.config.js（Windows 上曾因此找不到 tailwindcss 而构建失败）
    postcss: { plugins: [] },
  },
  server: {
    host: 'localhost',
    port: 1420,
    strictPort: true,
    hmr: { host: 'localhost', port: 1420 },
  },
});
