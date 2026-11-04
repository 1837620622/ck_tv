// 启动页：开场动画 → 读取设置 → 并行测速 → 进入首选或最快的线路。全部不可用时进入离线页。
//
// 进入站点时不做淡出：站点页面一开始，src/inject/remote.js 就在同一位置画出和启动页最后一帧
// 一样的画面（标志、字标、进度条），等站点加载好再淡出。从用户看，是同一个画面里站点慢慢出现。

import { inTauri, invoke } from './bridge.js';
import { applyPlatform, errorText, logError, saveProbes } from './common.js';
import { fill, h, icon, toast } from './dom.js';
import { hostOf, latencyLabel, pickBestServer } from './lib/servers.js';

const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'),
  status: $('status'),
  statusIcon: $('status-icon'),
  statusText: $('status-text'),
  version: $('version'),
  updates: $('open-updates'),
};

// 开场动画至少播这么久，和 pages.css 里的开场顺序对应（约 1 秒播完）
const INTRO_MS = 1000;
// 选好线路后停留一小会儿，让用户看清进入的是哪条线路
const SHOW_RESULT_MS = 320;
// 用户点了「线路与更新」之后，就不再自动进入线路
let autoEnter = true;
// 系统要求减少动态效果时，跳过开场动画
const reduceMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)'
).matches;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 状态行：一个小图标加一行字。tone 为 ok / err 时换颜色，err 时进度条变成静止的红色。 */
function setStatus(text, { tone = '', name = 'loader', spin = false } = {}) {
  ui.status.dataset.tone = tone;
  ui.app.dataset.state = tone === 'err' ? 'error' : '';
  ui.statusText.textContent = text;
  ui.status.title = text;
  fill(ui.statusIcon, icon(name, { size: 16, className: spin ? 'spin' : '' }));
}

/** 测速失败不影响启动，只是没有延迟数据 */
async function measure() {
  try {
    return await invoke('probe_servers');
  } catch (error) {
    logError('测速失败', error);
    return [];
  }
}

async function start() {
  // 开场动画和启动流程同时进行：动画播完、测速也完成，才继续往下走
  const intro = reduceMotion ? Promise.resolve() : wait(INTRO_MS);

  let info;
  try {
    info = await invoke('bootstrap');
  } catch (error) {
    logError('启动失败', error);
    setStatus(`启动失败：${errorText(error)}`, { tone: 'err', name: 'alert' });
    return;
  }

  applyPlatform(info.app);
  ui.version.textContent = `v${info.app.version}`;
  if (info.update.status === 'available' && !info.update.skipped) {
    ui.updates.append(
      h('span', {
        class: 'dot dot-ok',
        title: '有新版本',
        style: { marginLeft: '8px' },
      })
    );
  }

  const measuring = measure();
  await intro;
  if (autoEnter) setStatus('正在选择最快的线路…', { spin: true });

  const probes = await measuring;
  saveProbes(probes);
  if (!autoEnter) return;

  const best = pickBestServer(probes, info.settings.preferredServer);
  if (!best) {
    setStatus('所有线路都暂时连不上', { tone: 'err', name: 'wifiOff' });
    await wait(SHOW_RESULT_MS * 2);
    if (autoEnter) location.replace('offline.html');
    return;
  }

  const probe = probes.find((item) => item.url === best);
  const latency = probe ? ` · ${latencyLabel(probe)}` : '';
  setStatus(`正在进入 ${hostOf(best)}${latency}`, {
    tone: 'ok',
    name: 'checkCircle',
  });
  await wait(SHOW_RESULT_MS);
  if (!autoEnter) return;
  if (!inTauri) {
    // 浏览器预览里没有原生层，不会真正跳转，只把结果写在状态行里
    setStatus(`预览：已选好 ${hostOf(best)}${latency}`, {
      tone: 'ok',
      name: 'info',
    });
    return;
  }
  try {
    await invoke('open_server', { url: best });
  } catch (error) {
    logError('进入线路失败', error);
    setStatus(`进入线路失败：${errorText(error)}`, {
      tone: 'err',
      name: 'alert',
    });
  }
}

ui.updates.addEventListener('click', async () => {
  autoEnter = false;
  setStatus('已暂停自动进入，可以在「线路与更新」里选择线路', { name: 'info' });
  try {
    await invoke('open_updater', { tab: 'update' });
  } catch (error) {
    logError('打开更新中心失败', error);
    toast(errorText(error, '无法打开更新中心'), 'err');
  }
});

// 页面一打开就显示「正在准备」和旋转的图标，不等开场结束
setStatus('正在准备…', { spin: true });
start();
