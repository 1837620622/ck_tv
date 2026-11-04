// 下载页用的纯函数：格式化、状态文字、进度、地址检查。不碰 DOM，方便测试。

export const STATUS_RUNNING = 'running';
export const STATUS_DONE = 'done';
export const STATUS_FAILED = 'failed';
export const STATUS_CANCELED = 'canceled';
/** 分片已下载完、正在合成 MP4（原生层 downloads.rs 的 STAGE_CONVERTING） */
export const STAGE_CONVERTING = 'converting';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** 字节数转成人能看懂的写法：512 B、18.4 MB、2.1 GB */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** 进度百分比（0–100）。总量未知时返回 null，界面显示成不确定的进度条。 */
export function progressPercent(item) {
  if (item.status === STATUS_DONE) return 100;
  // 合成 MP4 时没有可报的进度，显示不确定的进度条
  if (item.stage === STAGE_CONVERTING) return null;
  if (!item.total) return null;
  return Math.min(100, Math.floor((item.done / item.total) * 100));
}

/** 进度文字：分片视频显示“已完成 / 总数 个分片”，文件显示大小 */
export function progressText(item) {
  if (item.status === STATUS_RUNNING && item.stage === STAGE_CONVERTING) {
    return '正在合成 MP4…';
  }
  if (item.kind === 'hls') {
    return item.total ? `${item.done} / ${item.total} 个分片` : '准备中…';
  }
  if (item.total) {
    return `${formatBytes(item.done)} / ${formatBytes(item.total)}`;
  }
  return item.done ? formatBytes(item.done) : '准备中…';
}

export function statusLabel(status) {
  switch (status) {
    case STATUS_RUNNING:
      return '下载中';
    case STATUS_DONE:
      return '已完成';
    case STATUS_FAILED:
      return '失败';
    case STATUS_CANCELED:
      return '已取消';
    default:
      return '未知';
  }
}

/** 状态标签的颜色：对应 components.css 里的 pill-* */
export function statusTone(status) {
  switch (status) {
    case STATUS_RUNNING:
      return 'pill-info';
    case STATUS_DONE:
      return 'pill-ok';
    case STATUS_FAILED:
      return 'pill-danger';
    default:
      return '';
  }
}

export function kindLabel(kind) {
  return kind === 'hls' ? '分片视频（HLS）' : '视频文件';
}

/** 只有下载完成的项目才有可以播放的入口文件 */
export function canPlay(item) {
  return item.status === STATUS_DONE && Boolean(item.path);
}

export function isRunning(item) {
  return item.status === STATUS_RUNNING;
}

/** 列表里显示的名字：用户填的名称优先，否则用地址的域名 */
export function displayTitle(item) {
  return item.title?.trim() || hostOf(item.source) || '未命名视频';
}

/** 列表顶部的概况，例如“共 3 项 · 进行中 1 项” */
export function summarize(items) {
  if (!items.length) return '还没有下载的视频';
  const running = items.filter(isRunning).length;
  return running
    ? `共 ${items.length} 项 · 进行中 ${running} 项`
    : `共 ${items.length} 项`;
}

/**
 * 去掉文件名，得到所在文件夹的路径（保留原来的分隔符，Windows 上是反斜杠）。
 * 例：/data/a1/index.m3u8 → /data/a1/
 */
export function folderOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index === -1 ? '' : path.slice(0, index + 1);
}

/**
 * 本地分片列表：分片文件名换成能播放的完整地址。
 * 本地 index.m3u8 里是相对文件名（00000.ts），而 asset 协议地址是整个路径编码成一段，
 * 相对地址解析不过去，所以播放前要先换成完整地址。toUrl 接收文件名，返回播放地址。
 */
export function rewritePlaylist(text, toUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      return toUrl(trimmed);
    })
    .join('\n');
}

/**
 * 把一条记录放进列表：同一个 id 就替换原位置，没有就放到最前面（最新的在前）。
 * 返回新数组，不修改原数组。
 */
export function upsertItem(items, item) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [item, ...items];
  const next = items.slice();
  next[index] = item;
  return next;
}

/** 地址的域名部分，用来在列表里显示“来自哪里” */
export function hostOf(source) {
  try {
    return new URL(source).host;
  } catch {
    return '';
  }
}

/**
 * 检查用户粘贴的地址。只接受 http 和 https。
 * 返回 { url } 或 { error }，error 是可以直接显示给用户的文字。
 */
export function checkSource(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: '请先粘贴视频地址' };
  if (text.length > 8192) return { error: '地址太长了，请检查是否粘贴完整' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: '地址格式不对，应以 https:// 或 http:// 开头' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: '只能下载 http 或 https 的地址' };
  }
  return { url: url.toString() };
}

/**
 * 站点发来的预填信息，放在下载页地址的查询参数里（?url=…&title=…）。
 * 只负责读出来：地址能不能用，要到提交时由 checkSource 检查。没有地址时返回 null。
 */
export function prefillFrom(search) {
  const params = new URLSearchParams(search);
  const url = params.get('url');
  if (!url) return null;
  return { url, title: (params.get('title') ?? '').slice(0, 80) };
}
