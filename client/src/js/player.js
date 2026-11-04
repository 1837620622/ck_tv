// CKTV 播放器：在线视频（站点里正在播的那一集）和下载好的视频都用它播放。
// 和站点自己的播放器分开，操作参考手机视频应用：
//   单击显示 / 隐藏控制栏，双击暂停 / 播放；左右滑动调进度；左侧上下滑调亮度，右侧上下滑调音量；
//   长按 2 倍速，松手恢复；倍速菜单、锁屏、画中画、横屏全屏、记住上次看到的位置。
// 全屏：安卓用原生接口（window.CKTVNative，见 scripts/patch-mobile.mjs）横屏并隐藏系统栏；
// iPhone 用系统自带的全屏播放器；电脑用网页全屏。

import { fileSrc, inTauri, invoke } from './bridge.js';
import { copyText, errorText, logError } from './common.js';
import { fill, h, icon, toast } from './dom.js';
import { folderOf, rewritePlaylist } from './lib/downloads.js';
import {
  classifyGesture,
  dimOpacity,
  formatDelta,
  formatTime,
  HOLD_SPEED,
  isPlaylist,
  progressKey,
  readParams,
  resumePoint,
  seekTarget,
  sourceLabel,
  speedLabel,
  SPEEDS,
  timeAtRatio,
  verticalLevel,
} from './lib/player.js';

const $ = (id) => document.getElementById(id);
const pl = $('pl');
const video = $('video');
const touch = $('touch');
const dim = $('dim');
const seek = $('seek');
const speedMenu = $('speed-menu');

const params = readParams(location.search);
const native = window.CKTVNative;
const isIOS =
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 手机横屏时直接铺满（和全屏一样的布局）
const landscape = window.matchMedia(
  '(orientation: landscape) and (max-height: 540px)'
);

const UI_HIDE_MS = 3200;
const HOLD_MS = 450;
const DOUBLE_TAP_MS = 280;
const SAVE_EVERY_MS = 5000;
const SEEK_STEP = 10;

const state = {
  hls: null,
  blobUrl: '',
  full: false,
  locked: false,
  brightness: 1,
  uiTimer: 0,
  hudTimer: 0,
  tapTimer: 0,
  lastTap: 0,
  gesture: null,
  seeking: false,
  holdRate: 0,
  lastSave: 0,
  netRetries: 0,
  mediaRetries: 0,
  wakeLock: null,
};

/* ================= 加载视频 ================= */

function destroyHls() {
  state.hls?.destroy();
  state.hls = null;
  if (state.blobUrl) {
    URL.revokeObjectURL(state.blobUrl);
    state.blobUrl = '';
  }
}

async function attach(url, playlist) {
  if (!playlist) {
    video.src = url;
    return;
  }
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
  // iPhone 自带的 HLS 播放更省电，也能用系统全屏；其它系统用 hls.js
  if (isIOS && nativeHls) {
    video.src = url;
    return;
  }
  const { default: Hls } = await import('hls.js/light');
  if (!Hls.isSupported()) {
    if (nativeHls) {
      video.src = url;
      return;
    }
    throw new Error('这个系统的网页引擎不支持分片视频播放');
  }
  const hls = new Hls({
    enableWorker: true,
    maxBufferLength: 30,
    backBufferLength: 20,
    startPosition: -1,
  });
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && state.netRetries < 2) {
      state.netRetries += 1;
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && state.mediaRetries < 1) {
      state.mediaRetries += 1;
      hls.recoverMediaError();
      return;
    }
    showError(
      params.src
        ? '视频加载失败：线路不通，或者这个视频不允许在应用里单独播放。可以返回网页播放。'
        : '播放中断了，文件可能不完整。可以删除后重新下载。'
    );
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  state.hls = hls;
}

async function load() {
  showError('');
  destroyHls();
  state.netRetries = 0;
  state.mediaRetries = 0;
  setBusy(true);
  try {
    if (params.src) {
      await attach(params.src, isPlaylist(params.src));
    } else if (params.file) {
      const url = fileSrc(params.file);
      if (!url) throw new Error('预览模式下没有本机文件可以播放');
      if (params.kind === 'hls') {
        // 保留分片的下载：把本地 index.m3u8 里的文件名换成完整地址
        const response = await fetch(url);
        if (!response.ok)
          throw new Error('找不到播放列表，文件可能被移动或删除了');
        const folder = folderOf(params.file);
        const text = rewritePlaylist(await response.text(), (name) =>
          fileSrc(folder + name)
        );
        state.blobUrl = URL.createObjectURL(
          new Blob([text], { type: 'application/vnd.apple.mpegurl' })
        );
        await attach(state.blobUrl, true);
      } else {
        await attach(url, false);
      }
    } else {
      throw new Error('没有要播放的视频');
    }
    // 自动播放可能被系统拦截，失败时点一下中间的播放键即可
    video.play().catch(() => setBusy(false));
  } catch (error) {
    logError('播放失败', error);
    showError(errorText(error, '这个视频无法播放'));
  }
}

function showError(text) {
  $('error').hidden = !text;
  $('error-text').textContent = text;
  if (text) setBusy(false);
}

function setBusy(busy) {
  $('spinner').hidden = !busy;
}

/* ================= 播放状态、进度 ================= */

function togglePlay() {
  if (video.paused || video.ended) video.play().catch(() => undefined);
  else video.pause();
}

function renderPlayState() {
  const playing = !video.paused && !video.ended;
  pl.dataset.playing = String(playing);
  const name = playing ? 'pause' : 'play';
  fill($('play'), icon(name, { size: 22 }));
  $('play').setAttribute('aria-label', playing ? '暂停' : '播放');
  fill($('big-play'), icon('play', { size: 30, stroke: 1.8 }));
  if (playing) scheduleHideUI();
  else showUI(false);
  keepScreenOn(playing);
}

function bufferedEnd(time) {
  const ranges = video.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= time + 0.5 && time <= ranges.end(index)) {
      return ranges.end(index);
    }
  }
  return time;
}

function renderProgress(time = video.currentTime) {
  const duration = video.duration;
  const ratio = Number.isFinite(duration) && duration > 0 ? time / duration : 0;
  const percent = `${Math.min(100, ratio * 100)}%`;
  $('seek-played').style.width = percent;
  $('seek-thumb').style.left = percent;
  if (Number.isFinite(duration) && duration > 0) {
    $('seek-buffer').style.width = `${Math.min(
      100,
      (bufferedEnd(video.currentTime) / duration) * 100
    )}%`;
  }
  $('time-current').textContent = formatTime(time);
  $('time-total').textContent = formatTime(duration);
  seek.setAttribute('aria-valuemax', String(Math.floor(duration || 0)));
  seek.setAttribute('aria-valuenow', String(Math.floor(time)));
  seek.setAttribute(
    'aria-valuetext',
    `${formatTime(time)} / ${formatTime(duration)}`
  );
}

/* ================= 控制栏显示 / 隐藏 ================= */

function showUI(autoHide = true) {
  pl.dataset.ui = 'shown';
  clearTimeout(state.uiTimer);
  if (autoHide) scheduleHideUI();
}

function hideUI() {
  if (!speedMenu.hidden || state.seeking) return;
  pl.dataset.ui = 'hidden';
}

function scheduleHideUI() {
  clearTimeout(state.uiTimer);
  if (video.paused) return;
  state.uiTimer = setTimeout(hideUI, UI_HIDE_MS);
}

function toggleUI() {
  if (pl.dataset.ui === 'hidden') showUI();
  else hideUI();
}

/* ================= 中间的提示（进度、亮度、音量、倍速） ================= */

function showHud(name, html, level = null) {
  clearTimeout(state.hudTimer);
  $('hud').hidden = false;
  fill($('hud-icon'), icon(name, { size: 26 }));
  // html 只来自本文件拼好的固定文字和数字
  $('hud-text').innerHTML = html;
  const bar = $('hud-bar');
  bar.hidden = level === null;
  if (level !== null) bar.firstElementChild.style.width = `${level * 100}%`;
}

function hideHud(delay = 500) {
  clearTimeout(state.hudTimer);
  state.hudTimer = setTimeout(() => {
    $('hud').hidden = true;
  }, delay);
}

function seekBy(seconds) {
  const duration = video.duration;
  if (!Number.isFinite(duration)) return;
  const target = Math.min(duration, Math.max(0, video.currentTime + seconds));
  video.currentTime = target;
  showHud(
    seconds < 0 ? 'rewind' : 'forward',
    `${formatTime(target)}<small>/ ${formatTime(duration)}</small>`
  );
  hideHud(700);
}

/* ================= 手势 ================= */

/** 手指移出画面也继续收到事件；系统不认这个指针时（例如已经抬起）忽略即可 */
function capture(element, pointerId) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // 不影响手势本身
  }
}

function startHold() {
  const gesture = state.gesture;
  if (!gesture || gesture.mode !== 'none' || video.paused) return;
  gesture.mode = 'hold';
  state.holdRate = video.playbackRate;
  video.playbackRate = HOLD_SPEED;
  showHud('forward', `${HOLD_SPEED}X 倍速播放中`);
}

function endHold() {
  video.playbackRate = state.holdRate || 1;
  state.holdRate = 0;
  hideHud(0);
}

function onTap() {
  const now = Date.now();
  if (now - state.lastTap < DOUBLE_TAP_MS) {
    clearTimeout(state.tapTimer);
    state.lastTap = 0;
    // 暂停时中间会出现大播放键，不再另外提示
    togglePlay();
    return;
  }
  state.lastTap = now;
  clearTimeout(state.tapTimer);
  state.tapTimer = setTimeout(() => {
    state.lastTap = 0;
    toggleUI();
  }, DOUBLE_TAP_MS);
}

function onPointerDown(event) {
  if (state.gesture || event.button > 0) return;
  closeSpeedMenu();
  // 鼠标：单击暂停 / 播放，双击全屏（在 click / dblclick 里处理）
  if (event.pointerType === 'mouse') return;
  if (state.locked) {
    showUI();
    return;
  }
  const rect = touch.getBoundingClientRect();
  capture(touch, event.pointerId);
  state.gesture = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    width: rect.width,
    height: rect.height,
    left: event.clientX - rect.left < rect.width / 2,
    mode: 'none',
    startTime: video.currentTime,
    startLevel: 0,
    target: video.currentTime,
    holdTimer: setTimeout(startHold, HOLD_MS),
  };
}

function onPointerMove(event) {
  const gesture = state.gesture;
  if (event.pointerType === 'mouse') {
    showUI();
    return;
  }
  if (!gesture || event.pointerId !== gesture.id || gesture.mode === 'hold') {
    return;
  }
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (gesture.mode === 'none') {
    const kind = classifyGesture(dx, dy);
    if (kind === 'none') return;
    clearTimeout(gesture.holdTimer);
    if (kind === 'seek') {
      if (!Number.isFinite(video.duration)) return;
      gesture.mode = 'seek';
    } else if (gesture.left) {
      gesture.mode = 'brightness';
      gesture.startLevel = state.brightness;
    } else {
      gesture.mode = 'volume';
      gesture.startLevel = video.muted ? 0 : video.volume;
    }
  }
  if (gesture.mode === 'seek') {
    gesture.target = seekTarget(
      gesture.startTime,
      dx,
      gesture.width,
      video.duration
    );
    renderProgress(gesture.target);
    showHud(
      dx < 0 ? 'rewind' : 'forward',
      `${formatTime(gesture.target)}<small>${formatDelta(
        gesture.target - gesture.startTime
      )}</small>`,
      gesture.target / video.duration
    );
  } else if (gesture.mode === 'brightness') {
    state.brightness = verticalLevel(gesture.startLevel, dy, gesture.height);
    dim.style.opacity = String(dimOpacity(state.brightness));
    showHud(
      'sun',
      `亮度 ${Math.round(state.brightness * 100)}%`,
      state.brightness
    );
  } else if (gesture.mode === 'volume') {
    if (isIOS) {
      // iPhone 上网页不能改音量
      showHud('volume', '请用手机侧边的音量键');
      return;
    }
    const level = verticalLevel(gesture.startLevel, dy, gesture.height);
    video.volume = level;
    video.muted = level === 0;
    showHud(
      level === 0 ? 'volumeOff' : 'volume',
      `音量 ${Math.round(level * 100)}%`,
      level
    );
  }
}

function onPointerUp(event) {
  const gesture = state.gesture;
  if (!gesture || event.pointerId !== gesture.id) return;
  clearTimeout(gesture.holdTimer);
  state.gesture = null;
  if (event.type === 'pointercancel') {
    if (gesture.mode === 'hold') endHold();
    hideHud(0);
    return;
  }
  switch (gesture.mode) {
    case 'hold':
      endHold();
      break;
    case 'seek':
      video.currentTime = gesture.target;
      hideHud(400);
      break;
    case 'brightness':
    case 'volume':
      hideHud(600);
      break;
    default:
      onTap();
  }
}

/* ================= 进度条拖动 ================= */

function ratioAt(event) {
  const rect = seek.getBoundingClientRect();
  return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
}

function onSeekDown(event) {
  if (!Number.isFinite(video.duration)) return;
  event.stopPropagation();
  state.seeking = true;
  seek.dataset.dragging = 'true';
  capture(seek, event.pointerId);
  showUI(false);
  renderProgress(timeAtRatio(ratioAt(event), video.duration));
}

function onSeekMove(event) {
  if (!state.seeking) return;
  renderProgress(timeAtRatio(ratioAt(event), video.duration));
}

function onSeekUp(event) {
  if (!state.seeking) return;
  state.seeking = false;
  seek.dataset.dragging = 'false';
  video.currentTime = timeAtRatio(ratioAt(event), video.duration);
  scheduleHideUI();
}

/* ================= 倍速 ================= */

function renderSpeed() {
  const rate = state.holdRate || video.playbackRate;
  const button = $('speed');
  button.textContent = speedLabel(rate);
  button.dataset.active = String(rate !== 1);
  for (const item of speedMenu.children) {
    item.setAttribute(
      'aria-checked',
      String(Number(item.dataset.rate) === rate)
    );
  }
}

function buildSpeedMenu() {
  fill(
    speedMenu,
    ...[...SPEEDS].reverse().map((rate) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitemradio',
          'data-rate': String(rate),
          onClick: () => {
            video.playbackRate = rate;
            renderSpeed();
            closeSpeedMenu();
            showHud('gauge', `${rate}X 倍速`);
            hideHud(700);
          },
        },
        `${rate}X`
      )
    )
  );
}

function toggleSpeedMenu() {
  speedMenu.hidden = !speedMenu.hidden;
  if (!speedMenu.hidden) {
    renderSpeed();
    showUI(false);
  } else {
    scheduleHideUI();
  }
}

function closeSpeedMenu() {
  if (!speedMenu.hidden) {
    speedMenu.hidden = true;
    scheduleHideUI();
  }
}

/* ================= 全屏、锁屏 ================= */

function renderLayout() {
  const full = state.full || landscape.matches;
  pl.classList.toggle('is-full', full);
  fill(
    $('fullscreen'),
    icon(full ? 'exitFullscreen' : 'fullscreen', { size: 22 })
  );
  $('fullscreen').setAttribute('aria-label', full ? '退出全屏' : '全屏');
  if (!full && state.locked) setLocked(false);
}

async function enterFull() {
  if (native?.setFullscreen) {
    // 安卓：原生层横屏并隐藏状态栏、导航栏
    native.setFullscreen(true);
    state.full = true;
    renderLayout();
    return;
  }
  if (isIOS && !document.fullscreenEnabled && video.webkitEnterFullscreen) {
    // iPhone：网页不能横屏，用系统自带的全屏播放器（会自动横过来）
    video.webkitEnterFullscreen();
    return;
  }
  try {
    await pl.requestFullscreen();
    await screen.orientation?.lock?.('landscape');
  } catch {
    // 不支持网页全屏或锁定方向时，至少把画面铺满窗口
  }
  state.full = true;
  renderLayout();
}

function exitFull() {
  if (native?.setFullscreen) native.setFullscreen(false);
  if (document.fullscreenElement)
    document.exitFullscreen().catch(() => undefined);
  screen.orientation?.unlock?.();
  state.full = false;
  renderLayout();
}

function toggleFull() {
  if (state.full || landscape.matches) exitFull();
  else enterFull();
}

function setLocked(locked) {
  state.locked = locked;
  pl.dataset.locked = String(locked);
  fill($('lock'), icon(locked ? 'lock' : 'unlock', { size: 20 }));
  $('lock').setAttribute('aria-label', locked ? '解除锁定' : '锁定屏幕');
  showUI();
}

/* ================= 返回 ================= */

function leave() {
  if (params.back) {
    location.href = params.back;
  } else if (history.length > 1) {
    history.back();
  } else {
    location.href = 'index.html';
  }
}

function goBack() {
  // 全屏时先退出全屏，再按一次才离开（和手机视频应用一样）
  if (state.full) {
    exitFull();
    return;
  }
  leave();
}

/* ================= 记住看到哪里 ================= */

const storageKey = progressKey(params.src || params.file);

function saveProgress(force = false) {
  const now = Date.now();
  if (!force && now - state.lastSave < SAVE_EVERY_MS) return;
  state.lastSave = now;
  try {
    if (video.ended) localStorage.removeItem(storageKey);
    else if (video.currentTime > 0)
      localStorage.setItem(storageKey, String(Math.floor(video.currentTime)));
  } catch {
    // 无法保存时下次从头播放，没有别的影响
  }
}

function resume() {
  let saved = 0;
  try {
    saved = Number(localStorage.getItem(storageKey));
  } catch {
    saved = 0;
  }
  const at = resumePoint(saved, video.duration);
  if (at > 0) {
    video.currentTime = at;
    toast(`已从 ${formatTime(at)} 继续播放`, 'info', 2200);
  }
}

/* ================= 亮屏 ================= */

async function keepScreenOn(on) {
  try {
    if (on && !state.wakeLock && navigator.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => {
        state.wakeLock = null;
      });
    } else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch {
    // 不支持时没有影响
  }
}

/* ================= 竖屏下面的信息和按钮 ================= */

function pipSupported() {
  return (
    (document.pictureInPictureEnabled && !video.disablePictureInPicture) ||
    Boolean(video.webkitSupportsPresentationMode?.('picture-in-picture'))
  );
}

async function enterPip() {
  try {
    if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    else video.webkitSetPresentationMode('picture-in-picture');
  } catch (error) {
    toast(errorText(error, '无法进入画中画'), 'err');
  }
}

async function downloadThis(button) {
  button.disabled = true;
  try {
    await invoke('download_start', {
      source: params.src,
      title: params.title || null,
    });
    toast('已开始下载，下载好后是一个 MP4 文件', 'ok');
  } catch (error) {
    logError('开始下载失败', error);
    toast(errorText(error, '无法开始下载'), 'err');
    button.disabled = false;
  }
}

function action(name, label, onClick) {
  const button = h(
    'button',
    { class: 'pl-action', type: 'button' },
    icon(name, { size: 20 }),
    h('span', {}, label)
  );
  button.addEventListener('click', () => onClick(button));
  return button;
}

function renderInfo() {
  const title = params.title || (params.file ? '本机视频' : '正在播放');
  document.title = `${title} - CKTV 播放器`;
  $('title').textContent = title;
  $('top-title').textContent = title;
  $('meta').textContent = sourceLabel(params);
  const actions = [];
  if (params.src) actions.push(action('download', '下载', downloadThis));
  actions.push(action('gauge', '倍速', toggleSpeedMenu));
  if (pipSupported()) actions.push(action('pip', '画中画', enterPip));
  actions.push(action('fullscreen', '全屏', enterFull));
  if (params.src) {
    actions.push(
      action('link', '复制地址', async () => {
        const ok = await copyText(params.src);
        toast(ok ? '视频地址已复制' : '复制失败', ok ? 'ok' : 'err');
      })
    );
  }
  actions.push(
    action('folder', '下载管理', () => {
      location.href = 'downloads.html';
    })
  );
  if (params.back && params.src)
    actions.push(action('globe', '回到网页', leave));
  fill($('actions'), ...actions);
}

/* ================= 键盘（电脑） ================= */

function onKey(event) {
  if (event.target instanceof HTMLInputElement) return;
  switch (event.key) {
    case ' ':
    case 'k':
      togglePlay();
      break;
    case 'ArrowLeft':
      seekBy(-SEEK_STEP);
      break;
    case 'ArrowRight':
      seekBy(SEEK_STEP);
      break;
    case 'ArrowUp':
    case 'ArrowDown': {
      const level = Math.min(
        1,
        Math.max(0, video.volume + (event.key === 'ArrowUp' ? 0.1 : -0.1))
      );
      video.volume = level;
      video.muted = level === 0;
      showHud(
        level === 0 ? 'volumeOff' : 'volume',
        `音量 ${Math.round(level * 100)}%`,
        level
      );
      hideHud(700);
      break;
    }
    case 'f':
      toggleFull();
      break;
    case 'Escape':
      if (!speedMenu.hidden) closeSpeedMenu();
      else if (state.full) exitFull();
      else return;
      break;
    default:
      return;
  }
  event.preventDefault();
  showUI();
}

/* ================= 启动 ================= */

function bindEvents() {
  touch.addEventListener('pointerdown', onPointerDown);
  touch.addEventListener('pointermove', onPointerMove);
  touch.addEventListener('pointerup', onPointerUp);
  touch.addEventListener('pointercancel', onPointerUp);
  touch.addEventListener('click', (event) => {
    if (event.pointerType === 'touch' || state.locked) return;
    // 只处理鼠标点击（触摸的点击在 pointerup 里处理）
    if (event.detail <= 1) togglePlay();
  });
  touch.addEventListener('dblclick', (event) => {
    if (event.pointerType !== 'touch') toggleFull();
  });
  touch.addEventListener('contextmenu', (event) => event.preventDefault());

  seek.addEventListener('pointerdown', onSeekDown);
  seek.addEventListener('pointermove', onSeekMove);
  seek.addEventListener('pointerup', onSeekUp);
  seek.addEventListener('pointercancel', onSeekUp);
  seek.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.stopPropagation();
      event.preventDefault();
      seekBy(event.key === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP);
    }
  });

  $('play').addEventListener('click', togglePlay);
  $('big-play').addEventListener('click', togglePlay);
  $('back').addEventListener('click', goBack);
  $('fullscreen').addEventListener('click', toggleFull);
  $('speed').addEventListener('click', toggleSpeedMenu);
  $('lock').addEventListener('click', () => setLocked(!state.locked));
  $('retry').addEventListener('click', load);
  $('error-back').addEventListener('click', leave);

  video.addEventListener('play', renderPlayState);
  video.addEventListener('pause', () => {
    renderPlayState();
    saveProgress(true);
  });
  video.addEventListener('ended', () => {
    renderPlayState();
    saveProgress(true);
  });
  video.addEventListener('waiting', () => setBusy(true));
  video.addEventListener('playing', () => setBusy(false));
  video.addEventListener('canplay', () => setBusy(false));
  video.addEventListener('loadedmetadata', () => {
    resume();
    renderProgress();
  });
  video.addEventListener('timeupdate', () => {
    if (!state.seeking && state.gesture?.mode !== 'seek') renderProgress();
    saveProgress();
  });
  video.addEventListener('progress', () => renderProgress());
  video.addEventListener('durationchange', () => renderProgress());
  video.addEventListener('ratechange', renderSpeed);
  video.addEventListener('error', () => {
    if (!state.hls) {
      showError(
        params.src
          ? '视频加载失败：线路不通，或者这个视频不允许在应用里单独播放。可以返回网页播放。'
          : '视频无法播放，文件可能不完整。'
      );
    }
  });

  landscape.addEventListener('change', renderLayout);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.full && !native?.setFullscreen) {
      state.full = false;
      renderLayout();
    }
  });
  document.addEventListener('keydown', onKey);
  // 离开页面：退出全屏、保存进度、释放解码器
  window.addEventListener('pagehide', () => {
    saveProgress(true);
    if (native?.setFullscreen) native.setFullscreen(false);
    keepScreenOn(false);
    destroyHls();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveProgress(true);
    else if (!video.paused) keepScreenOn(true);
  });
}

function init() {
  fill($('back'), icon('arrowLeft', { size: 22 }));
  setLocked(false);
  buildSpeedMenu();
  renderSpeed();
  renderPlayState();
  renderLayout();
  renderInfo();
  renderProgress();
  bindEvents();
  if (!inTauri && !params.src && !params.file) {
    showError('预览：请在地址后面加上 ?src=视频地址');
    return;
  }
  load();
}

init();
