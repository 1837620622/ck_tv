/*
 * CKTV 客户端的站点注入脚本。站点页面开始加载前执行一次；本地页面（启动页、离线页、更新中心）不做界面的事。
 *
 * 1. 给 <html> 加上平台标记（data-cktv-platform / data-cktv-mobile），站点可以据此微调样式。
 * 2. 开场：应用启动后第一次进入站点时，盖一层品牌画面，页面加载完再淡出。
 * 3. 断网或线路响应异常时在顶部提示，可以一键切换线路；网络恢复后提示刷新。
 * 4. 收到「发现新版本」事件时，在右下角（手机上是底部）显示提示卡片。
 * 5. 切回前台时通知原生层，由它决定要不要检查更新。
 * 6. 页面在播放视频时，左下角显示「下载本集」和「列表」：只读取资源加载记录，不改写站点的请求。
 *
 * 站点不能直接调用原生功能：所有操作都是跳转到 cktv:// 地址，由原生侧拦截处理
 * （见 src-tauri/src/window.rs 的 handle_action）。界面都放在 Shadow DOM 里，
 * 和站点的样式互不影响。
 */
(() => {
  if (window.__CKTV_REMOTE_READY__) return;
  window.__CKTV_REMOTE_READY__ = true;

  const app = window.__CKTV_APP__ || {};

  // 平台标记要写在 <html> 上；脚本开始执行时如果还没有 <html>，就等 DOMContentLoaded
  const markRoot = () => {
    const root = document.documentElement;
    if (!root) return false;
    if (app.platform) root.dataset.cktvPlatform = app.platform;
    if (app.mobile) root.dataset.cktvMobile = 'true';
    return true;
  };
  if (!markRoot()) {
    document.addEventListener('DOMContentLoaded', markRoot, { once: true });
  }

  // 本地页面（启动页、离线页、更新中心）自己有界面，这里不做任何事
  const onLocalPage =
    location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';
  if (onLocalPage) return;

  // 动画和提示只在顶层页面出现；站点里嵌入的 iframe（比如播放器）不管
  const isTopFrame = window.top === window;
  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;

  const FONT =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
  const CURTAIN_KEY = 'cktv-curtain-shown';
  const DISMISS_KEY = 'cktv-update-dismissed';
  // 开场画面至少停留这么久；页面超过最长时间还没加载完，也会先退场
  const CURTAIN_MIN_MS = 1600;
  const CURTAIN_MAX_MS = 3500;
  // 30 秒内连续失败 3 次才提示，偶尔一次失败不打扰
  const FAILURE_WINDOW_MS = 30_000;
  const FAILURE_LIMIT = 3;
  // 用户关掉「线路异常」提示后，10 分钟内不再提示
  const SNOOZE_MS = 10 * 60_000;
  // 网络恢复的提示显示这么久后自动收起
  const ONLINE_BANNER_MS = 5000;
  // 离开应用超过 1 分钟再回来，才通知原生层检查更新
  const RESUME_MIN_HIDDEN_MS = 60_000;

  /* ---------- 通用工具 ---------- */

  // 站点页面请求原生层做事，只能通过 cktv:// 地址（原生侧拦截，页面本身不会跳转）
  function nativeAction(path) {
    location.href = `cktv://${path}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, onClick) {
    const button = el('button', 'act', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  // 脚本开始执行时文档可能还没有 <body>，有了再挂载界面
  function whenBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  // 用 Shadow DOM 挂载一层界面：样式只作用于这一层，站点的样式也碰不到它
  function mountLayer(name, css, node) {
    const host = el('div');
    host.setAttribute(`data-cktv-${name}`, '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(el('style', null, css), node);
    document.body.append(host);
    return { host, node };
  }

  /* ---------- 样式和图形 ---------- */

  // 和 src/assets/logo.svg 是同一个标志，只是拆成了几个部件，方便做动画
  const MARK_SVG = `
    <svg viewBox="0 0 512 512" focusable="false" aria-hidden="true">
      <defs>
        <linearGradient id="cktv-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#18231F"/>
          <stop offset="1" stop-color="#060908"/>
        </linearGradient>
        <radialGradient id="cktv-glow" cx="0.42" cy="0.4" r="0.62">
          <stop offset="0" stop-color="#22C55E" stop-opacity="0.3"/>
          <stop offset="1" stop-color="#22C55E" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="cktv-ring" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stop-color="#A7F3D0"/>
          <stop offset="0.45" stop-color="#34D399"/>
          <stop offset="1" stop-color="#059669"/>
        </linearGradient>
        <linearGradient id="cktv-play" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#FFFFFF"/>
          <stop offset="1" stop-color="#D1FAE5"/>
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill="url(#cktv-bg)"/>
      <rect width="512" height="512" rx="116" fill="url(#cktv-glow)"/>
      <rect x="3" y="3" width="506" height="506" rx="113" fill="none" stroke="#FFFFFF" stroke-opacity="0.1" stroke-width="3"/>
      <path class="mk-ring" pathLength="100" d="M 372.6 347.1 A 148 148 0 1 1 372.6 164.9" fill="none" stroke="url(#cktv-ring)" stroke-width="46" stroke-linecap="round"/>
      <path class="mk-play" d="M 222 196 L 222 316 L 322 256 Z" fill="url(#cktv-play)" stroke="url(#cktv-play)" stroke-width="26" stroke-linejoin="round"/>
      <circle class="mk-dot" cx="404" cy="256" r="17" fill="#6EE7B7"/>
    </svg>`;

  const MARK_CSS = `
    .mk-ring { stroke-dasharray: 100 100; stroke-dashoffset: 100; animation: draw 1s cubic-bezier(.2,.8,.2,1) .12s forwards; }
    .mk-play { transform-box: fill-box; transform-origin: center; transform: scale(.4); opacity: 0; animation: pop .6s cubic-bezier(.34,1.56,.64,1) .5s forwards; }
    .mk-dot { opacity: 0; animation: fade-in .4s ease .85s forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    @keyframes pop { to { opacity: 1; transform: scale(1); } }
  `;

  const CURTAIN_CSS = `
    :host { all: initial; }
    .curtain {
      position: fixed; inset: 0; z-index: 2147483646;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      box-sizing: border-box; padding: env(safe-area-inset-top, 0px) 24px env(safe-area-inset-bottom, 0px);
      color: #ecfdf5; font: 14px/1.5 ${FONT};
      background: radial-gradient(90% 60% at 50% 38%, #0f2e25 0%, #060a13 60%, #04060d 100%);
      transition: opacity .5s cubic-bezier(.4,0,.2,1), transform .5s cubic-bezier(.4,0,.2,1);
    }
    .curtain.out { opacity: 0; transform: scale(1.03); pointer-events: none; }
    .mark { width: 96px; height: 96px; animation: mark-in .8s cubic-bezier(.2,.8,.2,1) both; }
    .mark svg { display: block; width: 100%; height: 100%; overflow: visible; }
    .name {
      margin-top: 18px; font-size: 26px; font-weight: 800; letter-spacing: .3em; padding-left: .3em;
      animation: rise .6s cubic-bezier(.2,.8,.2,1) .3s both;
    }
    .sub {
      margin-top: 4px; color: #8ea3a0; font-size: 12px; letter-spacing: .3em; padding-left: .3em;
      animation: rise .6s cubic-bezier(.2,.8,.2,1) .45s both;
    }
    .pledge {
      margin-top: 14px; color: #6ee7b7; font-size: 12px; letter-spacing: .12em;
      animation: fade-in .6s ease .55s both;
    }
    .loader {
      position: relative; overflow: hidden; width: 120px; height: 3px; margin-top: 26px; border-radius: 3px;
      background: rgba(255,255,255,.08); animation: fade-in .4s ease .5s both;
    }
    .loader i {
      position: absolute; top: 0; bottom: 0; width: 40%; border-radius: inherit;
      background: linear-gradient(90deg, rgba(74,222,128,0), #4ade80, rgba(74,222,128,0));
      animation: sweep 1.3s cubic-bezier(.45,0,.55,1) infinite;
    }
    @keyframes mark-in { from { opacity: 0; transform: scale(.84) rotate(-6deg); } to { opacity: 1; transform: none; } }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes sweep { from { left: -40%; } to { left: 100%; } }
    @media (prefers-reduced-motion: reduce) { .curtain { transition: none; } }
  `;

  const UPDATE_CSS = `
    :host { all: initial; }
    .card {
      position: fixed; z-index: 2147483647;
      right: 20px; bottom: 20px; width: min(360px, calc(100vw - 32px));
      box-sizing: border-box; padding: 16px 16px 14px;
      border-radius: 16px; color: #e8eefc;
      background: linear-gradient(160deg, rgba(30,41,59,.92), rgba(15,23,42,.94));
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 18px 50px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.06);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      font: 14px/1.5 ${FONT};
      animation: rise .42s cubic-bezier(.2,.8,.2,1) both;
    }
    @media (max-width: 640px) {
      .card { left: 12px; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); width: auto; }
    }
    .row { display: flex; gap: 12px; align-items: flex-start; }
    .badge {
      flex: none; width: 40px; height: 40px; border-radius: 12px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      box-shadow: 0 8px 20px rgba(34,197,94,.35);
    }
    .main { flex: 1; min-width: 0; }
    .title { font-weight: 650; font-size: 15px; letter-spacing: .2px; }
    .version { color: #86efac; font-weight: 600; }
    .notes {
      margin: 4px 0 0; color: #93a0bd; font-size: 12.5px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }
    button {
      font: inherit; cursor: pointer; border-radius: 10px; padding: 8px 14px; border: 0;
      transition: transform .15s ease, background .15s ease, opacity .15s ease;
    }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid #4ade80; outline-offset: 2px; }
    .primary { color: #052e16; background: linear-gradient(135deg, #4ade80, #22c55e); font-weight: 650; }
    .ghost { color: #cbd5e1; background: rgba(255,255,255,.07); }
    .ghost:hover { background: rgba(255,255,255,.12); }
    @keyframes rise { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  `;

  const BANNER_CSS = `
    :host { all: initial; }
    .banner {
      position: fixed; z-index: 2147483646; left: 50%;
      top: calc(10px + env(safe-area-inset-top, 0px));
      transform: translateX(-50%);
      box-sizing: border-box; width: min(560px, calc(100vw - 24px));
      display: flex; align-items: center; gap: 10px;
      padding: 9px 8px 9px 14px; border-radius: 14px;
      color: #e8eefc; background: rgba(15,23,42,.95);
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 14px 40px rgba(0,0,0,.45);
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      font: 13.5px/1.45 ${FONT};
      animation: drop .36s cubic-bezier(.2,.8,.2,1) backwards;
      transition: opacity .26s ease, transform .26s ease;
    }
    .banner[data-kind='offline'] { border-color: rgba(248,113,113,.45); }
    .banner[data-kind='degraded'] { border-color: rgba(250,204,21,.45); }
    .banner[data-kind='online'] { border-color: rgba(74,222,128,.5); }
    .banner.out { opacity: 0; transform: translate(-50%, -8px); }
    .dot {
      flex: none; width: 9px; height: 9px; border-radius: 50%;
      background: #f87171; box-shadow: 0 0 0 4px rgba(248,113,113,.18);
    }
    .banner[data-kind='degraded'] .dot { background: #facc15; box-shadow: 0 0 0 4px rgba(250,204,21,.18); }
    .banner[data-kind='online'] .dot { background: #4ade80; box-shadow: 0 0 0 4px rgba(74,222,128,.18); }
    .text { flex: 1; min-width: 0; }
    button {
      font: inherit; cursor: pointer; border: 0; border-radius: 10px;
      transition: transform .15s ease, background .15s ease;
    }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid #4ade80; outline-offset: 2px; }
    .act { flex: none; padding: 7px 12px; white-space: nowrap; color: #052e16; background: linear-gradient(135deg, #4ade80, #22c55e); font-weight: 650; }
    .close {
      flex: none; width: 30px; height: 30px; padding: 0; display: grid; place-items: center;
      color: #cbd5e1; background: rgba(255,255,255,.07); font-size: 18px; line-height: 1;
    }
    @keyframes drop { from { opacity: 0; transform: translate(-50%, -12px); } to { opacity: 1; transform: translateX(-50%); } }
    @media (prefers-reduced-motion: reduce) { .banner { animation: none; } }
  `;

  /* ---------- 开场：第一次进入站点时的品牌画面 ---------- */

  function curtainShown() {
    try {
      return sessionStorage.getItem(CURTAIN_KEY) === '1';
    } catch {
      return false;
    }
  }

  function markCurtainShown() {
    try {
      sessionStorage.setItem(CURTAIN_KEY, '1');
    } catch {
      /* 无法保存时，下次进入站点还会有开场，没有别的影响 */
    }
  }

  function entryCurtain() {
    // 系统要求减少动态效果，或者这次打开应用已经播过了，就不再盖画面
    if (reduceMotion || curtainShown()) return;
    markCurtainShown();

    const started = performance.now();
    const curtain = el('div', 'curtain');
    curtain.setAttribute('aria-hidden', 'true');
    const mark = el('div', 'mark');
    mark.innerHTML = MARK_SVG;
    const loader = el('div', 'loader');
    loader.append(el('i'));
    curtain.append(
      mark,
      el('div', 'name', 'CKTV'),
      el('div', 'sub', '传康播放器'),
      el('div', 'pledge', '非盈利 · 免费 · 无偿提供'),
      loader
    );
    const layer = mountLayer('curtain', CURTAIN_CSS + MARK_CSS, curtain);

    // 页面加载完成后退场，但至少停留 CURTAIN_MIN_MS；超过 CURTAIN_MAX_MS 不管加载没加载完都退场
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      const wait = Math.max(0, CURTAIN_MIN_MS - (performance.now() - started));
      setTimeout(() => {
        curtain.classList.add('out');
        setTimeout(() => layer.host.remove(), 520);
      }, wait);
    };
    if (document.readyState === 'complete') close();
    else window.addEventListener('load', close, { once: true });
    setTimeout(close, CURTAIN_MAX_MS);
  }

  /* ---------- 更新提示卡片 ---------- */

  let updateLayer = null;

  function dismissedVersions() {
    try {
      return JSON.parse(sessionStorage.getItem(DISMISS_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function rememberDismissed(version) {
    try {
      const list = dismissedVersions();
      if (!list.includes(version)) list.push(version);
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(list));
    } catch {
      /* 隐私模式下无法保存也没关系，只是下次还会提示 */
    }
  }

  function hideUpdate() {
    if (updateLayer) updateLayer.host.remove();
    updateLayer = null;
  }

  function showUpdate(detail) {
    if (!detail || !detail.version) return;
    const version = detail.version;
    if (dismissedVersions().includes(version)) return;
    whenBody(() => {
      hideUpdate();

      const card = el('section', 'card');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'CKTV 有新版本');

      const row = el('div', 'row');
      const badge = el('div', 'badge');
      badge.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#052e16" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>';
      const main = el('div', 'main');
      const title = el('div', 'title');
      title.append(
        '发现新版本 ',
        el('span', 'version', 'v' + String(version).replace(/^v/, ''))
      );
      main.append(title);
      if (detail.notes) main.append(el('p', 'notes', String(detail.notes)));
      row.append(badge, main);

      const actions = el('div', 'actions');
      const later = el('button', 'ghost', '稍后');
      later.type = 'button';
      later.addEventListener('click', () => {
        rememberDismissed(version);
        hideUpdate();
      });
      const view = el('button', 'primary', '查看更新');
      view.type = 'button';
      // 原生侧会拦截这个动作并打开更新中心
      view.addEventListener('click', () => nativeAction('updater'));
      actions.append(later, view);

      card.append(row, actions);
      updateLayer = mountLayer('update', UPDATE_CSS, card);
      view.focus({ preventScroll: true });
    });
  }

  /* ---------- 顶部提示：断网、线路异常、网络恢复 ---------- */

  const BANNER_TEXT = {
    offline: '网络已断开。恢复后请刷新页面',
    degraded: '线路响应异常，页面可能加载不全',
    online: '网络已恢复，可以刷新页面看看',
  };
  const banner = { kind: '', layer: null, timer: 0 };
  const failures = [];
  let snoozeUntil = 0;
  // 不看 navigator.onLine 的初始值：页面能加载出来，说明网络是通的；断网和恢复只看事件
  let offline = false;

  function hideBanner() {
    clearTimeout(banner.timer);
    const current = banner.layer;
    banner.kind = '';
    banner.layer = null;
    banner.timer = 0;
    if (!current) return;
    current.node.classList.add('out');
    setTimeout(() => current.host.remove(), 300);
  }

  function showBanner(kind) {
    if (banner.kind === kind) return;
    hideBanner();
    banner.kind = kind;
    whenBody(() => {
      if (banner.kind !== kind || banner.layer) return;
      const node = el('div', 'banner');
      node.dataset.kind = kind;
      node.setAttribute('role', 'status');
      node.append(el('span', 'dot'), el('span', 'text', BANNER_TEXT[kind]));
      if (kind === 'degraded') {
        node.append(
          actionButton('切换线路', () => nativeAction('updater?tab=servers'))
        );
      }
      if (kind === 'online') {
        node.append(actionButton('刷新', () => location.reload()));
      }
      let layer = null;
      const close = el('button', 'close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', '关闭提示');
      close.addEventListener('click', () => {
        if (kind === 'degraded') snoozeUntil = Date.now() + SNOOZE_MS;
        if (layer && banner.layer === layer) hideBanner();
      });
      node.append(close);
      layer = mountLayer('banner', BANNER_CSS, node);
      banner.layer = layer;
      if (kind === 'online') {
        banner.timer = setTimeout(hideBanner, ONLINE_BANNER_MS);
      }
    });
  }

  function watchNetwork() {
    window.addEventListener('offline', () => {
      offline = true;
      failures.length = 0;
      showBanner('offline');
    });
    window.addEventListener('online', () => {
      offline = false;
      showBanner('online');
    });
  }

  // 站点接口失败的计数：网络错误，或者返回 503 / 504。只统计同源的 /api/ 请求。
  function isSiteApi(input) {
    try {
      const raw =
        typeof input === 'string'
          ? input
          : input && input.url
          ? input.url
          : String(input);
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  }

  function noteFailure() {
    // 断网时的失败不是线路的问题，交给断网提示
    if (offline) return;
    const now = Date.now();
    failures.push(now);
    while (failures.length && now - failures[0] > FAILURE_WINDOW_MS) {
      failures.shift();
    }
    if (failures.length >= FAILURE_LIMIT && now >= snoozeUntil) {
      showBanner('degraded');
    }
  }

  function noteSuccess() {
    failures.length = 0;
    if (banner.kind === 'degraded') hideBanner();
  }

  // 包住 fetch 只为了统计结果，请求本身、返回值和报错都原样交给站点
  function watchSiteHealth() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== 'function') return;
    window.fetch = function cktvFetch(input, init) {
      const request = nativeFetch.call(this, input, init);
      if (!isSiteApi(input)) return request;
      return request.then(
        (response) => {
          if (response.status === 503 || response.status === 504) {
            noteFailure();
          } else {
            noteSuccess();
          }
          return response;
        },
        (error) => {
          // 网络错误是 TypeError；页面主动取消的请求（AbortError）不算
          if (error instanceof TypeError) noteFailure();
          throw error;
        }
      );
    };
  }

  /* ---------- 切回前台：通知原生层检查更新 ---------- */

  function watchResume() {
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      // 只是短暂切走不用管；离开够久了，原生层会再判断距离上次检查是否足够久
      if (away >= RESUME_MIN_HIDDEN_MS) nativeAction('resume');
    });
  }

  /* ---------- 下载按钮：页面在播放视频时，显示「下载本集」和「列表」 ---------- */

  // 只读取资源加载记录，不改写站点自己的请求。分片列表（.m3u8）优先，没有时用 .mp4 直链。
  const DOWNLOAD_LABEL = '下载本集';
  // 点了只是打开下载页、把地址填好，还要在那边确认，所以不能写成「已开始下载」
  const DOWNLOAD_DONE_LABEL = '已打开下载页';
  const DOWNLOAD_DONE_MS = 2500;
  const latestStream = { m3u8: '', mp4: '' };
  let dock = null; // { node, download, list, close, url }
  let dismissedStream = '';

  // 返回 'm3u8' 或 'mp4'；不是 http(s) 的视频地址返回空字符串（blob: 之类的地址播放器内部用，无法下载）
  function streamKind(raw) {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      const match = /\.(m3u8|mp4)$/i.exec(url.pathname);
      return match ? match[1].toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function noteStream(raw) {
    const kind = streamKind(raw);
    if (!kind) return;
    latestStream[kind] = new URL(raw, location.href).href;
    refreshDock();
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach((video) => {
      noteStream(video.currentSrc || video.src || '');
    });
  }

  function pageTitle() {
    return String(document.title || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  function mountDock() {
    const node = el('div', 'dock');
    node.hidden = true;
    const download = el('button', 'main', DOWNLOAD_LABEL);
    download.type = 'button';
    const list = el('button', 'sub', '列表');
    list.type = 'button';
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '隐藏下载按钮');
    node.append(download, list, close);
    dock = { node, download, list, close, url: '' };

    download.addEventListener('click', () => {
      if (!dock.url) return;
      const query = `url=${encodeURIComponent(
        dock.url
      )}&title=${encodeURIComponent(pageTitle())}`;
      nativeAction(`download?${query}`);
      download.textContent = DOWNLOAD_DONE_LABEL;
      setTimeout(() => {
        download.textContent = DOWNLOAD_LABEL;
      }, DOWNLOAD_DONE_MS);
    });
    list.addEventListener('click', () => nativeAction('downloads'));
    close.addEventListener('click', () => {
      dismissedStream = dock.url;
      dock.node.hidden = true;
    });
    mountLayer('dock', DOCK_CSS, node);
  }

  function refreshDock() {
    const url = latestStream.m3u8 || latestStream.mp4;
    if (!url || url === dismissedStream) {
      if (dock) dock.node.hidden = true;
      return;
    }
    whenBody(() => {
      if (!dock) mountDock();
      dock.url = url;
      dock.node.hidden = false;
    });
  }

  function watchStreams() {
    try {
      // buffered: true 会把页面开始加载以来的记录也读进来
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) noteStream(entry.name);
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // 不支持资源记录的环境：只靠下面的视频元素判断
    }
    document.addEventListener('play', scanVideos, true);
    document.addEventListener('loadedmetadata', scanVideos, true);
  }

  const DOCK_CSS = `
    [hidden] { display: none !important; }
    .dock {
      position: fixed;
      left: calc(12px + env(safe-area-inset-left, 0px));
      bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      z-index: 2147483000;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 999px;
      background: rgb(9 14 26 / 0.9);
      border: 1px solid rgb(148 163 184 / 0.22);
      box-shadow: 0 10px 28px rgb(0 0 0 / 0.4);
      backdrop-filter: blur(12px);
      font: 500 13px/1 ${FONT};
      color: #e2e8f0;
      animation: dock-in 0.32s ease both;
    }
    .dock button {
      appearance: none;
      margin: 0;
      height: 32px;
      padding: 0 12px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .dock .main {
      padding: 0 14px;
      color: #052e16;
      font-weight: 700;
      background: linear-gradient(135deg, #4ade80, #16a34a);
    }
    .dock .sub:hover {
      background: rgb(148 163 184 / 0.16);
    }
    .dock .close {
      width: 30px;
      padding: 0;
      color: #94a3b8;
      font-size: 18px;
    }
    .dock .close:hover {
      color: #e2e8f0;
      background: rgb(148 163 184 / 0.16);
    }
    @keyframes dock-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dock { animation: none; }
    }
  `;

  /* ---------- 入口 ---------- */

  window.addEventListener('cktv:update', (event) => showUpdate(event.detail));

  if (isTopFrame) {
    // 这两项要尽早装上，才能统计到页面一开始的请求
    watchSiteHealth();
    watchResume();
    watchStreams();
    whenBody(() => {
      entryCurtain();
      watchNetwork();
    });
  }
})();
