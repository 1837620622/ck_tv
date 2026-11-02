// 下载页：新建下载、看进度、播放、全屏、取消和删除。
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
  folderOf,
  hostOf,
  isRunning,
  kindLabel,
  prefillFrom,
  progressPercent,
  progressText,
  rewritePlaylist,
  STATUS_DONE,
  statusLabel,
  statusTone,
  summarize,
  upsertItem,
} from './lib/downloads.js';

const $ = (id) => document.getElementById(id);

const player = $('player');
const video = $('video');
const list = $('list');

const state = {
  app: null,
  mobile: false,
  items: [], // 最新的在前，和原生层的顺序一致
  rows: new Map(), // id → 列表里对应的那一行
  playing: null, // 正在播放的记录
  hls: null, // hls.js 实例，只有播放分片视频时才有
  blobUrl: null, // 分片播放列表的临时地址，关闭播放时释放
  fullscreen: false, // 桌面端：窗口是否处于全屏
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
  // 播放器打开时，Esc 由播放器处理，不关闭整个下载窗口
  if (document.querySelector('dialog[open]')) return;
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
  if (state.playing?.id === id) closePlayer();
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

/* ================= 播放器 ================= */

function setPlayerError(message) {
  const node = $('player-error');
  node.hidden = !message;
  node.textContent = message || '';
}

function updateFullscreenButton() {
  const on = state.mobile
    ? Boolean(document.fullscreenElement)
    : state.fullscreen;
  const button = $('player-fs');
  fill(button, icon(on ? 'exitFullscreen' : 'fullscreen', { size: 20 }));
  button.setAttribute('aria-label', on ? '退出全屏' : '全屏');
}

async function setWindowFullscreen(on) {
  try {
    await getCurrentWindow().setFullscreen(on);
    state.fullscreen = on;
  } catch (error) {
    logError('切换全屏失败', error);
  }
  updateFullscreenButton();
}

async function toggleFullscreen() {
  if (inTauri && !state.mobile) {
    await setWindowFullscreen(!state.fullscreen);
    return;
  }
  // 手机端和浏览器预览：用网页的全屏接口。iPhone 不支持整块全屏，只能让视频本身全屏。
  if (document.fullscreenElement) {
    await document.exitFullscreen().catch(() => undefined);
  } else if (document.fullscreenEnabled && player.requestFullscreen) {
    await player.requestFullscreen().catch(() => undefined);
  } else if (video.webkitEnterFullscreen) {
    video.webkitEnterFullscreen();
  } else {
    toast('这个系统不支持全屏播放', 'info');
  }
  updateFullscreenButton();
}

/** 第一次按 Esc 先退出全屏，第二次才关闭播放器 */
function onPlayerCancel(event) {
  if (!state.fullscreen) return;
  event.preventDefault();
  setWindowFullscreen(false);
}

/** 释放视频占用的内存：解码器、缓冲的数据、分片播放列表 */
function releasePlayer() {
  state.playing = null;
  state.hls?.destroy();
  state.hls = null;
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function closePlayer() {
  if (state.fullscreen) setWindowFullscreen(false);
  releasePlayer();
  if (player.open) player.close();
}

/**
 * 分片视频：读取本地 index.m3u8，把分片文件名换成完整地址，交给 hls.js 播放。
 * hls.js 只在播放分片视频时才下载，所以放在这里动态加载。
 */
async function playSegments(item) {
  const { default: Hls } = await import('hls.js/light');
  const folder = folderOf(item.path);
  const response = await fetch(fileSrc(item.path));
  if (!response.ok) throw new Error('找不到播放列表，文件可能被移动或删除了');
  const playlist = rewritePlaylist(await response.text(), (name) =>
    fileSrc(folder + name)
  );
  state.blobUrl = URL.createObjectURL(
    new Blob([playlist], { type: 'application/vnd.apple.mpegurl' })
  );

  if (Hls.isSupported()) {
    // 只保留当前位置前后一小段，不把整部视频都留在内存里
    const hls = new Hls({ maxBufferLength: 30, backBufferLength: 20 });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal)
        setPlayerError('播放中断了，文件可能不完整。可以删除后重新下载。');
    });
    hls.loadSource(state.blobUrl);
    hls.attachMedia(video);
    state.hls = hls;
    return;
  }
  // 没有 MSE 的系统（部分旧版 iPhone）：使用系统自带的 HLS 播放
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = state.blobUrl;
    return;
  }
  throw new Error('这个系统的网页引擎不支持分片视频播放');
}

async function openPlayer(item) {
  if (!canPlay(item)) return;
  if (!fileSrc(item.path)) {
    toast('预览模式下没有本机文件可以播放', 'info');
    return;
  }
  closePlayer();
  state.playing = item;
  $('player-title').textContent = displayTitle(item);
  setPlayerError('');
  if (!player.open) player.showModal();
  try {
    if (item.kind === 'hls') await playSegments(item);
    else video.src = fileSrc(item.path);
    // 自动播放可能被系统拦截，失败时用户点一下播放按钮即可
    video.play().catch(() => undefined);
  } catch (error) {
    logError('播放失败', error);
    setPlayerError(errorText(error, '这个视频无法播放'));
  }
}

/* ================= 启动 ================= */

function bindEvents() {
  $('new-form').addEventListener('submit', onSubmit);
  // 下载页已经开着时，站点的下载按钮会发来这个事件（见 window.rs 的 open_downloads）
  window.addEventListener('cktv:prefill', (event) => prefill(event.detail));
  $('open-folder').addEventListener('click', openFolder);
  $('player-close').addEventListener('click', closePlayer);
  $('player-fs').addEventListener('click', toggleFullscreen);
  player.addEventListener('cancel', onPlayerCancel);
  // 关闭事件是异步的：如果此时又打开了新的视频，就不能释放它
  player.addEventListener('close', () => {
    if (!player.open) releasePlayer();
  });
  video.addEventListener('error', () => {
    if (state.playing && !state.hls)
      setPlayerError('视频无法播放，文件可能不完整。');
  });
  document.addEventListener('fullscreenchange', updateFullscreenButton);
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
  updateFullscreenButton();
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
