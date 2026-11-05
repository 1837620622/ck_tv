// 和原生层通信的唯一入口。
// - 在 Tauri 里：调用 Rust 命令、监听事件。
// - 在普通浏览器里预览界面（npm run build 之后打开 dist 或 vite 开发服务器）：使用模拟数据，方便调界面。

import { convertFileSrc, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

export const inTauri =
  typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);

export async function invoke(command, args) {
  if (inTauri) return tauriInvoke(command, args);
  return mockInvoke(command, args);
}

export async function listen(event, handler) {
  if (inTauri) {
    return tauriListen(event, (payload) => handler(payload.payload));
  }
  return () => undefined;
}

/**
 * 本机文件路径 → 网页能播放的地址（Tauri 的 asset 协议，只开放下载目录）。
 * 浏览器预览时没有本机文件，返回空字符串。
 */
export function fileSrc(path) {
  if (!inTauri || !path) return '';
  return convertFileSrc(path);
}

/* ---------- 浏览器预览用的模拟数据 ---------- */

const params =
  typeof location !== 'undefined'
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const scenario = params.get('mock') || 'uptodate'; // uptodate | update | skipped | offline | error | mobile | mobile-update
// 预览时模拟所在地区：cn | other | unknown；mirror=none 时模拟清单里没有国内线路
const region = params.get('region') || 'other';
const withMirror = params.get('mirror') !== 'none';

const mockSettings = {
  autoCheckUpdates: true,
  checkIntervalHours: 12,
  skippedVersion: scenario === 'skipped' ? '1.1.0' : null,
  customServers: ['https://mirror.example.org'],
  preferredServer: null,
  lastGoodServer: 'https://tv.chuankangkk.top',
  lastCheckedAt: Date.now() - 3 * 3600_000,
};

const mobile = scenario.startsWith('mobile');

// 预览用的安装包信息。文件名和大小只是示意，国内线路也是示意地址。
const RELEASE_URL =
  'https://github.com/1837620622/ck_tv/releases/tag/app-v1.1.0';
const ASSET_BASE =
  'https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0';
const PREVIEW_FILES = {
  macos: ['macOS 安装包', 'CKTV_1.1.0_macos.dmg', 48_000_000],
  windows: ['Windows 安装程序', 'CKTV_1.1.0_windows-setup.exe', 42_000_000],
  linux: ['Linux AppImage', 'CKTV_1.1.0_linux.AppImage', 61_000_000],
  android: ['安卓 APK', 'CKTV_1.1.0_android.apk', 22_000_000],
  ios: ['iPhone / iPad 安装包', 'CKTV_1.1.0_ios-unsigned.ipa', 19_000_000],
};
const mockDownload = (platform) => {
  const [label, file, size] = PREVIEW_FILES[platform] ?? [
    '安装包',
    'CKTV.zip',
    null,
  ];
  const mirrorUrl = withMirror
    ? `https://mirror.example.org/cktv/${file}`
    : null;
  return {
    label,
    url: `${ASSET_BASE}/${file}`,
    mirrorUrl,
    mirrors: mirrorUrl
      ? [
          mirrorUrl,
          `https://gh-proxy.com/${ASSET_BASE}/${file}`,
          `https://edgeone.gh-proxy.com/${ASSET_BASE}/${file}`,
        ]
      : [],
    sha256: 'a3f1c9…7b2e',
    size,
    sourceUrl:
      platform === 'ios'
        ? 'https://github.com/1837620622/ck_tv/releases/latest/download/altstore.json'
        : null,
  };
};

const mockUpdate = () => {
  const base = {
    status: 'upToDate',
    platform: mobile
      ? params.get('os') === 'ios'
        ? 'ios'
        : 'android'
      : 'linux',
    currentVersion: '1.0.0',
    latestVersion: null,
    notes: null,
    publishedAt: null,
    download: null,
    releaseUrl: null,
    region,
    skipped: false,
    error: null,
    checkedAt: mockSettings.lastCheckedAt,
  };
  if (
    scenario === 'update' ||
    scenario === 'skipped' ||
    scenario === 'mobile-update'
  ) {
    return {
      ...base,
      status: 'available',
      latestVersion: '1.1.0',
      notes:
        '## 本次更新\n- 线路测速更快，启动页自动选择最快的线路\n- 修复全屏下拖动进度条卡顿的问题\n- 新增**自动检查更新**，可在「更新中心」关闭\n- 更新说明支持 `代码` 和 [帮助文档](https://tv.chuankangkk.top)',
      publishedAt: '2026-11-01',
      releaseUrl: RELEASE_URL,
      download: mockDownload(base.platform),
      skipped: scenario === 'skipped',
    };
  }
  if (scenario === 'error')
    return {
      ...base,
      status: 'error',
      error: '检查更新失败：无法连接更新服务',
    };
  return base;
};

const mockServers = (urls) =>
  urls.map((url, index) => {
    if (scenario === 'offline')
      return {
        url,
        ok: false,
        status: null,
        latencyMs: null,
        error: index % 2 ? '连接超时' : '无法连接',
      };
    return {
      url,
      ok: index !== 2,
      status: index !== 2 ? 200 : 503,
      latencyMs: [182, 436, 0, 920][index % 4] || 260,
      error: index === 2 ? '服务器错误 503' : null,
    };
  });

const mockCandidates = () => {
  const list = ['https://tv.chuankangkk.top', 'https://ck-tv.pages.dev'];
  return [...list, ...mockSettings.customServers];
};

// 下载列表的预览数据：完成、下载中、失败各一条，方便看每种状态。预览里没有本机文件，所以 path 为空。
const mockDownloads = [
  {
    id: 'demo-running',
    title: '示例 · 下载中',
    source: 'https://cdn.example.com/show/index.m3u8',
    kind: 'hls',
    entry: 'demo-running/index.m3u8',
    status: 'running',
    done: 14,
    total: 40,
    error: null,
    createdMs: Date.now() - 60_000,
    path: '',
  },
  {
    id: 'demo-done',
    title: '示例 · 已完成',
    source: 'https://cdn.example.com/movie.mp4',
    kind: 'file',
    entry: 'demo-done.mp4',
    status: 'done',
    done: 52_428_800,
    total: 52_428_800,
    error: null,
    createdMs: Date.now() - 3_600_000,
    path: '/preview/demo-done.mp4',
  },
  {
    id: 'demo-failed',
    title: '示例 · 失败',
    source: 'https://cdn.example.com/broken.m3u8',
    kind: 'hls',
    entry: 'demo-failed/index.m3u8',
    status: 'failed',
    done: 3,
    total: 40,
    error: '分片下载失败：服务器返回 403',
    createdMs: Date.now() - 7_200_000,
    path: '',
  },
];

async function mockInvoke(command, args = {}) {
  await new Promise((resolve) => setTimeout(resolve, 120));
  switch (command) {
    case 'bootstrap':
      return {
        app: {
          name: 'CKTV',
          version: '1.0.0',
          identifier: 'top.chuankangkk.cktv',
          platform: mobile
            ? params.get('os') === 'ios'
              ? 'ios'
              : 'android'
            : 'linux',
          arch: 'x86_64',
          mobile,
          debug: true,
          userAgent: 'CKTV-App/1.0.0 (preview)',
        },
        settings: structuredClone(mockSettings),
        candidates: mockCandidates(),
        update: mockUpdate(),
      };
    case 'app_info':
      return (await mockInvoke('bootstrap')).app;
    case 'get_settings':
      return structuredClone(mockSettings);
    case 'save_settings': {
      const patch = args.patch || {};
      Object.assign(mockSettings, patch);
      if ('skippedVersion' in patch)
        mockSettings.skippedVersion = patch.skippedVersion;
      return structuredClone(mockSettings);
    }
    case 'probe_servers': {
      const urls = args.urls || mockCandidates();
      return mockServers(urls);
    }
    case 'update_state':
    case 'check_update':
      return mockUpdate();
    case 'diagnostics':
      return {
        app: await mockInvoke('app_info'),
        settings: structuredClone(mockSettings),
        update: mockUpdate(),
        logDir: '/home/you/.local/share/top.chuankangkk.cktv/logs',
        candidates: mockCandidates(),
      };
    case 'download_list':
      return structuredClone(mockDownloads);
    case 'download_start': {
      const source = String(args.url ?? '');
      const created = {
        id: `demo-${Date.now()}`,
        title: args.title || source,
        source,
        kind: /\.m3u8(\?|$)/i.test(source) ? 'hls' : 'file',
        entry: '',
        status: 'running',
        done: 0,
        total: 0,
        error: null,
        createdMs: Date.now(),
        path: '',
      };
      mockDownloads.unshift(created);
      return structuredClone(created);
    }
    case 'download_cancel':
    case 'download_delete': {
      const index = mockDownloads.findIndex((row) => row.id === args.id);
      if (index === -1) throw new Error('找不到这条下载记录');
      if (command === 'download_delete') mockDownloads.splice(index, 1);
      else
        mockDownloads[index] = { ...mockDownloads[index], status: 'canceled' };
      return null;
    }
    case 'log_message':
    case 'open_server':
    case 'open_home':
    case 'open_updater':
    case 'open_external':
    case 'open_logs_dir':
    case 'restart_app':
    case 'download_open':
    case 'download_folder':
      // 浏览器预览时在控制台里能看到每次“调用”了什么，方便调界面
      // eslint-disable-next-line no-console -- 仅用于浏览器预览的调试输出
      console.info(`[preview] ${command}`, args);
      return null;
    default:
      throw new Error(`未知命令：${command}`);
  }
}
