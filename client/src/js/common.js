// 三个页面共用的小工具：平台名称、错误文字、剪贴板、外部链接、线路测速缓存。

import { invoke } from './bridge.js';
import { toast } from './dom.js';

const PLATFORM_NAMES = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
};
const PROBE_KEY = 'cktv:probes';

export function platformLabel(platform) {
  return PLATFORM_NAMES[platform] ?? (platform || '未知平台');
}

/** Tauri 命令失败时返回的是字符串；浏览器预览里是 Error 对象。这里统一成一句中文。 */
export function errorText(error, fallback = '操作没有成功，请稍后再试') {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** 把错误写进应用日志，方便反馈问题。写日志失败不影响界面。 */
export function logError(context, error) {
  const message = `${context}：${errorText(error, '未知错误')}`;
  // eslint-disable-next-line no-console -- 同时输出到开发者工具，方便调试
  console.error(message);
  invoke('log_message', { level: 'error', message }).catch(() => undefined);
}

/** 把平台信息挂到 <html> 上，样式和脚本都可以用 */
export function applyPlatform(app) {
  const root = document.documentElement;
  if (app?.platform) root.dataset.platform = app.platform;
  root.dataset.mobile = String(Boolean(app?.mobile));
}

/** 用系统浏览器打开外部链接（原生层只允许白名单域名） */
export async function openExternal(url) {
  try {
    await invoke('open_external', { url });
  } catch (error) {
    logError('打开链接失败', error);
    toast(errorText(error, '无法打开这个链接'), 'err');
  }
}

/** 复制文字。剪贴板接口不可用时，退回到选中文本再复制的方式。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

/** 启动页的测速结果放进 sessionStorage，离线页直接读取。关闭窗口后自动清空。 */
export function saveProbes(probes) {
  try {
    sessionStorage.setItem(
      PROBE_KEY,
      JSON.stringify({ at: Date.now(), probes })
    );
  } catch {
    // 隐私模式或存储被禁用时忽略：离线页会重新测速
  }
}

export function readProbes() {
  try {
    const data = JSON.parse(sessionStorage.getItem(PROBE_KEY) || 'null');
    return data && Array.isArray(data.probes) ? data : null;
  } catch {
    return null;
  }
}
