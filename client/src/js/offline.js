// 离线页：所有线路都连不上时显示。列出每条线路的测速结果，可以重试或切换线路；
// 网络恢复或倒计时结束后会自动重试。

import { invoke } from './bridge.js';
import { errorText, logError, readProbes, saveProbes } from './common.js';
import { fill, h, toast } from './dom.js';
import { relativeTime } from './lib/format.js';
import { hostOf, latencyLabel, latencyTone } from './lib/servers.js';

const $ = (id) => document.getElementById(id);
const RETRY_SECONDS = 30;

const reasons = $('reasons');
const meta = h('p', { class: 'hint offline-meta', 'aria-live': 'polite' });
reasons.after(meta);

let result = null; // { at, probes }
let remaining = RETRY_SECONDS;
let timer = null;

function retry() {
  location.replace('index.html');
}

function renderMeta() {
  const measured = result?.at
    ? `上次测速：${relativeTime(result.at)}`
    : '还没有测速结果';
  meta.textContent = timer
    ? `${measured} · ${remaining} 秒后自动重试`
    : measured;
}

function renderReasons(probes) {
  fill(
    reasons,
    ...probes.map((probe, index) =>
      h(
        'li',
        { class: 'item', style: { animationDelay: `${index * 60}ms` } },
        h('span', { class: `dot dot-${latencyTone(probe)}` }),
        h(
          'span',
          { class: 'item-main' },
          h('span', { class: 'item-title' }, hostOf(probe.url)),
          h(
            'span',
            { class: 'item-sub' },
            probe.ok ? '可以连接' : probe.error || '暂时不可用'
          )
        ),
        probe.ok
          ? h('span', { class: 'route-meta' }, latencyLabel(probe))
          : null
      )
    )
  );
}

function startCountdown() {
  stopCountdown();
  remaining = RETRY_SECONDS;
  timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      stopCountdown();
      retry();
      return;
    }
    renderMeta();
  }, 1000);
  renderMeta();
}

function stopCountdown() {
  if (timer) clearInterval(timer);
  timer = null;
  renderMeta();
}

async function openUpdater(tab) {
  try {
    await invoke('open_updater', { tab });
  } catch (error) {
    logError('打开更新中心失败', error);
    toast(errorText(error, '无法打开更新中心'), 'err');
  }
}

async function load() {
  result = readProbes();
  if (!result) {
    // 没有启动页留下的结果（比如直接打开了这个页面），现场测一次
    meta.textContent = '正在测速…';
    try {
      const probes = await invoke('probe_servers');
      saveProbes(probes);
      result = { at: Date.now(), probes };
    } catch (error) {
      logError('测速失败', error);
      toast(errorText(error, '测速失败'), 'err');
    }
  }
  renderReasons(result?.probes ?? []);
  startCountdown();
}

$('retry').addEventListener('click', retry);
$('switch-line').addEventListener('click', () => {
  stopCountdown();
  openUpdater('servers');
});
$('open-updates').addEventListener('click', () => {
  stopCountdown();
  openUpdater('update');
});
window.addEventListener('online', retry);

load();
