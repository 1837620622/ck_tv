// 下载页：新建下载、看进度、播放（用 CKTV 播放器）、取消和删除。
// 桌面端是独立窗口，使用自绘标题栏；手机端是主窗口里的页面，顶部有返回按钮。
// 视频保存在本机，播放时直接读本机文件，不经过网络。
// 进度事件到了只替换对应的那一行，不重建整个列表。

import { getCurrentWindow } from '@tauri-apps/api/window';

import { fileSrc, inTauri, invoke, listen } from './bridge.js';
import { applyPlatform, errorText, logError } from './common.js';
import { busy, fill, h, icon, toast } from './dom.js';
import {
  canPlay,
  checkSource,
  displayTitle,
  hostOf,
  isRunning,
  kindLabel,
  prefillFrom,
  progressPercent,
  progressText,
  STATUS_DONE,
  statusLabel,
  statusTone,
  summarize,
  upsertItem,
} from './lib/downloads.js';

const $ = (id) => document.getElementById(id);

const list = $('list');

const state = {
  app: null,
  mobile: false,
  items: [], // 最新的在前，和原生层的顺序一致
  rows: new Map(), // id → 列表里对应的那一行
};

/* ================= 窗口与导航 ================= */

async function windowAction(action) {
  if (!inTauri) {
    toast('预览模式下无法操作窗口', 'info');
    return;
  }
  try {
    const win = getCurrentWindow();
    if (action === 'minimize') await win.minimize();
    else await win.close();
  } catch (error) {
    logError('窗口操作失败', error);
  }
}

function goBack() {
  // 从网页上的下载按钮进来时，返回上一页（正在看的视频）；否则回到启动页
  if (history.length > 1) history.back();
  else if (inTauri)
    invoke('open_home').catch((error) => logError('返回失败', error));
  else location.href = 'index.html';
}

function applyChrome() {
  $('titlebar').hidden = state.mobile;
  $('topbar').hidden = !state.mobile;
  if (state.mobile) {
    fill($('back'), icon('arrowLeft', { size: 20 }));
    $('back').addEventListener('click', goBack);
  } else {
    $('tb-min').addEventListener('click', () => windowAction('minimize'));
    $('tb-close').addEventListener('click', () => windowAction('close'));
  }
}

function onKeydown(event) {
  if (state.mobile) return;
  const typing =
    event.target instanceof Element &&
    event.target.closest('input, select, textarea');
  if (event.key === 'Escape' && !typing) windowAction('close');
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    windowAction('close');
  }
}

/* ================= 列表 ================= */

function actionButton(
  label,
  iconName,
  onClick,
  variant = 'btn-ghost',
  extra = ''
) {
  return h(
    'button',
    {
      class: `btn btn-sm ${variant} ${extra}`.trim(),
      type: 'button',
      onclick: onClick,
    },
    icon(iconName, { size: 15 }),
    label
  );
}

/** 「删除」需要点两次：第一次变成「确认删除」，3 秒内没有第二次点击就恢复 */
function deleteButton(item) {
  const button = actionButton('删除', 'trash');
  let timer = 0;
  const reset = () => {
    clearTimeout(timer);
    fill(button, icon('trash', { size: 15 }), '删除');
    button.classList.replace('btn-danger', 'btn-ghost');
    button.dataset.armed = 'false';
  };
  button.addEventListener('click', () => {
    if (button.dataset.armed !== 'true') {
      fill(button, icon('trash', { size: 15 }), '确认删除');
      button.classList.replace('btn-ghost', 'btn-danger');
      button.dataset.armed = 'true';
      timer = setTimeout(reset, 3000);
      return;
    }
    reset();
    remove(item);
  });
  return button;
}

function actionsFor(item) {
  if (isRunning(item)) {
    return [actionButton('取消', 'x', () => cancel(item))];
  }
  const actions = [];
  if (canPlay(item)) {
    actions.push(
      actionButton('播放', 'play', () => openPlayer(item), 'btn-primary')
    );
    // 用系统自带的播放器打开：只在桌面端显示（手机上没有这个入口）
    actions.push(
      actionButton(
        '系统播放器',
        'external',
        () => openWithSystem(item),
        'btn-ghost',
        'desktop-only'
      )
    );
  } else if (item.status !== STATUS_DONE) {
    actions.push(actionButton('重新下载', 'refresh', () => retry(item)));
  }
  actions.push(deleteButton(item));
  return actions;
}

/** 进度条：总量未知时显示来回滑动的样式，不显示具体的百分比 */
function progressBar(item) {
  const percent = progressPercent(item);
  const unknown = percent === null;
  return h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-label': '下载进度',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': unknown ? undefined : percent,
    },
    h('div', {
      class: unknown ? 'progress-fill indeterminate' : 'progress-fill',
      style: { width: unknown ? '40%' : `${percent}%` },
    })
  );
}

function renderRow(item) {
  const showBar = isRunning(item) || item.status === STATUS_DONE;
  return h(
    'article',
    { class: 'item dl-item', 'data-status': item.status },
    h(
      'div',
      { class: 'item-main' },
      h(
        'div',
        { class: 'dl-head' },
        h('span', { class: 'item-title' }, displayTitle(item)),
        h(
          'span',
          { class: `pill ${statusTone(item.status)}` },
          statusLabel(item.status)
        )
      ),
      h(
        'span',
        { class: 'item-sub' },
        `${kindLabel(item.kind)} · ${hostOf(item.source) || '未知来源'}`
      ),
      showBar ? progressBar(item) : null,
      h('span', { class: 'item-sub dl-progress' }, progressText(item)),
      item.error ? h('span', { class: 'hint error' }, item.error) : null,
      h('div', { class: 'dl-actions' }, actionsFor(item))
    )
  );
}

function updateSummary() {
  $('summary').textContent = summarize(state.items);
  $('empty').hidden = state.items.length > 0;
}

/** 替换或新增一行。原生层每次进度变化都会发来一条记录，只动这一行。 */
function showItem(view) {
  state.items = upsertItem(state.items, view);
  const row = renderRow(view);
  const previous = state.rows.get(view.id);
  if (previous) previous.replaceWith(row);
  else list.prepend(row);
  state.rows.set(view.id, row);
  updateSummary();
}

function dropItem(id) {
  state.items = state.items.filter((row) => row.id !== id);
  state.rows.get(id)?.remove();
  state.rows.delete(id);
  updateSummary();
}

function renderAll() {
  state.rows.clear();
  const rows = state.items.map((item) => {
    const row = renderRow(item);
    state.rows.set(item.id, row);
    return row;
  });
  fill(list, ...rows);
  updateSummary();
}

async function refresh() {
  state.items = await invoke('download_list');
  renderAll();
}

/* ================= 操作 ================= */

async function cancel(item) {
  try {
    await invoke('download_cancel', { id: item.id });
    await refresh();
  } catch (error) {
    logError('取消下载失败', error);
    toast(errorText(error, '无法取消下载'), 'err');
  }
}

async function remove(item) {
  try {
    await invoke('download_delete', { id: item.id });
    dropItem(item.id);
    toast('已删除', 'ok');
  } catch (error) {
    logError('删除下载失败', error);
    toast(errorText(error, '删除没有成功'), 'err');
  }
}

/** 失败或取消的项目：用同样的地址和名称重新下载，成功后再删除旧记录 */
async function retry(item) {
  try {
    const view = await invoke('download_start', {
      url: item.source,
      title: item.title || null,
    });
    showItem(view);
    await invoke('download_delete', { id: item.id });
    dropItem(item.id);
  } catch (error) {
    logError('重新下载失败', error);
    toast(errorText(error, '无法重新下载'), 'err');
  }
}

async function openWithSystem(item) {
  try {
    await invoke('download_open', { id: item.id });
  } catch (error) {
    logError('打开文件失败', error);
    toast(errorText(error, '无法用系统播放器打开'), 'err');
  }
}

async function openFolder() {
  try {
    await invoke('download_folder');
  } catch (error) {
    logError('打开文件夹失败', error);
    toast(errorText(error, '无法打开文件夹'), 'err');
  }
}

/* ================= 新建下载 ================= */

function showSourceError(message) {
  const input = $('source');
  input.setAttribute('aria-invalid', String(Boolean(message)));
  $('source-error').hidden = !message;
  $('source-error').textContent = message ?? '';
}

async function onSubmit(event) {
  event.preventDefault();
  const check = checkSource($('source').value);
  if (check.error) {
    showSourceError(check.error);
    $('source').focus();
    return;
  }
  showSourceError('');
  const restore = busy($('submit'), '正在加入…');
  try {
    const view = await invoke('download_start', {
      url: check.url,
      title: $('title').value.trim() || null,
    });
    showItem(view);
    $('source').value = '';
    $('title').value = '';
    toast(
      state.mobile ? '已加入下载，可以留在当前页面' : '已加入下载列表',
      'ok'
    );
  } catch (error) {
    logError('开始下载失败', error);
    showSourceError(errorText(error, '无法开始下载'));
  } finally {
    restore();
  }
}

/* ================= 站点预填 ================= */

/**
 * 站点上点「下载」时，原生层只是打开这个页面，并把地址和名称填进表单。
 * 不会开始下载，要用户在这里点「开始下载」确认。页面内容不可信，所以只写进输入框，不当作指令执行。
 */
function prefill(detail) {
  if (!detail?.url) return;
  $('source').value = String(detail.url);
  $('title').value = String(detail.title ?? '');
  showSourceError('');
  toast('已填入视频地址，确认后点「开始下载」', 'info');
}

/** 页面是带着参数打开的（手机上从站点跳转过来）：读完就清掉参数，刷新时不会再填一次 */
function prefillFromPage() {
  const detail = prefillFrom(location.search);
  if (!detail) return;
  try {
    history.replaceState(history.state, '', location.pathname);
  } catch {
    /* 清不掉也没关系，只是刷新时会再填一次 */
  }
  prefill(detail);
}

/* ================= 播放 ================= */

/**
 * 用 CKTV 播放器播放下载好的视频：手势、长按倍速、横屏全屏、记住看到哪里，都和在线播放一样。
 * 播放器里按「返回」回到下载页。
 */
function openPlayer(item) {
  if (!canPlay(item)) return;
  if (!fileSrc(item.path)) {
    toast('预览模式下没有本机文件可以播放', 'info');
    return;
  }
  const query = new URLSearchParams({
    file: item.path,
    kind: item.kind,
    title: displayTitle(item),
    back: 'downloads.html',
  });
  location.href = `player.html?${query}`;
}

/* ================= 启动 ================= */

function bindEvents() {
  $('new-form').addEventListener('submit', onSubmit);
  // 下载页已经开着时，站点的下载按钮会发来这个事件（见 window.rs 的 open_downloads）
  window.addEventListener('cktv:prefill', (event) => prefill(event.detail));
  $('open-folder').addEventListener('click', openFolder);
  document.addEventListener('keydown', onKeydown);
}

function showPageError(message) {
  const node = $('page-error');
  node.hidden = !message;
  node.textContent = message || '';
}

async function init() {
  bindEvents();
  prefillFromPage();
  try {
    state.app = await invoke('app_info');
    state.mobile = Boolean(state.app.mobile);
    applyPlatform(state.app);
  } catch (error) {
    logError('读取应用信息失败', error);
  }
  applyChrome();
  try {
    // 先订阅进度事件，再读列表，避免读取期间的变化丢失
    await listen('download-changed', showItem);
    await refresh();
  } catch (error) {
    logError('读取下载列表失败', error);
    showPageError(errorText(error, '无法读取下载列表，请稍后再试'));
  }
}

init();
