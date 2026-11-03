// 启动页：开场动画 → 读取设置 → 并行测速 → 进入首选或最快的线路。全部不可用时进入离线页。

import { inTauri, invoke } from './bridge.js';
import { applyPlatform, errorText, logError, saveProbes } from './common.js';
import { fill, h, icon, toast } from './dom.js';
import {
  hostOf,
  latencyLabel,
  latencyTone,
  pickBestServer,
} from './lib/servers.js';

const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'),
  status: $('status'),
  statusIcon: $('status-icon'),
  statusText: $('status-text'),
  routes: $('routes'),
  version: $('version'),
  updates: $('open-updates'),
};

// 开场动画至少播这么久。时间和 pages.css 里各元素的动画对应，最后一个元素（说明文字）约 1.9 秒完成。
const INTRO_MS = 1900;
// 测速结束后停留一小会儿，让用户看清选中了哪条线路
const SHOW_RESULT_MS = 480;
// 启动页淡出的时间，和 pages.css 里 .boot.leaving 的 transition 一致
const LEAVE_MS = 300;
// 用户点了「线路与更新」之后，就不再自动进入线路
let autoEnter = true;
// 系统要求减少动态效果时，跳过开场动画
const reduceMotion = window.matchMedia(
  '(prefers-reduced-motion: reduce)'
).matches;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text, { tone = '', name = 'loader', spin = false } = {}) {
  ui.status.dataset.tone = tone;
  ui.statusText.textContent = text;
  fill(ui.statusIcon, icon(name, { size: 18, className: spin ? 'spin' : '' }));
}

/** 线路列表：测速前显示「测速中」，测完显示延迟，选中的那条高亮 */
function renderRoutes(urls, probes = new Map(), best = null) {
  fill(
    ui.routes,
    ...urls.map((url, index) => {
      const probe = probes.get(url);
      return h(
        'li',
        {
          class: `route${url === best ? ' best' : ''}`,
          title: url,
          style: { animationDelay: `${index * 70}ms` },
        },
        h('span', { class: `dot dot-${probe ? latencyTone(probe) : 'busy'}` }),
        h('span', { class: 'route-host' }, hostOf(url)),
        h(
          'span',
          { class: 'route-meta' },
          probe ? latencyLabel(probe) : '测速中…'
        )
      );
    })
  );
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

  const urls = info.candidates;
  const measuring = measure();
  await intro;
  renderRoutes(urls);
  if (autoEnter) setStatus('正在测速线路…', { spin: true });

  const probes = await measuring;
  saveProbes(probes);

  const best = pickBestServer(probes, info.settings.preferredServer);
  renderRoutes(urls, new Map(probes.map((probe) => [probe.url, probe])), best);
  if (!autoEnter) return;

  if (!best) {
    setStatus('所有线路都暂时连不上', { tone: 'err', name: 'wifiOff' });
    await wait(SHOW_RESULT_MS);
    if (autoEnter) location.replace('offline.html');
    return;
  }

  setStatus(`已选择 ${hostOf(best)}，正在进入…`, {
    tone: 'ok',
    name: 'checkCircle',
  });
  await wait(SHOW_RESULT_MS);
  if (!autoEnter) return;
  if (!inTauri) {
    // 浏览器预览里没有原生层，不会真正跳转，只把结果写在状态栏里
    setStatus(`预览模式：已选好 ${hostOf(best)}，桌面应用中将进入`, {
      tone: 'ok',
      name: 'info',
    });
    return;
  }
  // 启动页先淡出，再进入站点。窗口底色和启动页一致，切换时不会闪白。
  ui.app.classList.add('leaving');
  await wait(LEAVE_MS);
  try {
    await invoke('open_server', { url: best });
  } catch (error) {
    ui.app.classList.remove('leaving');
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
