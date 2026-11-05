// 更新中心：「更新」「线路」「关于」三个标签页。
// 桌面端是独立窗口，使用自绘标题栏；手机端是主窗口里的页面，顶部有返回按钮。
// 面板结构只创建一次，之后只替换里面的内容，避免正在输入的表单被刷新掉。

import { getCurrentWindow } from '@tauri-apps/api/window';

import { inTauri, invoke, listen } from './bridge.js';
import {
  applyPlatform,
  copyText,
  errorText,
  logError,
  openExternal,
  platformLabel,
} from './common.js';
import { busy, clear, fill, h, icon, toast } from './dom.js';
import {
  downloadAction,
  downloadLines,
  mirrorUrlList,
} from './lib/download.js';
import { interval, relativeTime } from './lib/format.js';
import { parseNotes } from './lib/markdown.js';
import {
  hostOf,
  latencyLabel,
  latencyTone,
  normalizeServerInput,
  pickBestServer,
} from './lib/servers.js';
import { describeUpdate } from './lib/status.js';
import { displayVersion } from './lib/version.js';
import logoUrl from '../assets/logo.svg?url';

const $ = (id) => document.getElementById(id);

const TABS = ['update', 'servers', 'about'];
const INTERVAL_OPTIONS = [6, 12, 24, 168];
const PROBE_TTL_MS = 2 * 60_000;
const CHECK_TTL_MS = 10 * 60_000;
const DEFAULT_HINT = '只支持 https 地址，添加后会自动测速。';
const LINKS = {
  feedback: 'https://github.com/1837620622/ck_tv/issues',
  repo: 'https://github.com/1837620622/ck_tv',
  site: 'https://tv.chuankangkk.top',
};
// 关于页的品牌说明。每一条都是应用实际做到的事，改之前先对照代码。
const PLEDGE = ['非盈利', '免费', '无偿提供'];
const BRAND_POINTS = [
  [
    'shield',
    '不内置、不传播任何影视资源。内容来自公开的第三方接口，在线播放。下载的视频只保存在你自己的设备上，仅供个人离线观看。',
  ],
  [
    'check',
    '应用本身不做统计。网络请求只用于访问站点线路，以及 GitHub 上的版本清单。',
  ],
  ['alert', '站点含 18+ 栏目，只面向年满 18 周岁的访客。'],
];
// 客户端额外提供的功能：开场动画、断网与线路提示、回到前台检查、线路测速
const APP_FEATURES = [
  [
    'zap',
    '开场与进入动画',
    '启动时播放品牌动画；每次打开应用，第一次进入站点时还有一段过渡画面。',
  ],
  [
    'signal',
    '断网与线路提示',
    '断网或线路响应异常时在页面顶部提示，可以一键切换线路。',
  ],
  [
    'refresh',
    '回到前台检查更新',
    '切回应用时，距离上次检查超过半小时，就检查一次（自动检查关闭时不检查）。',
  ],
  [
    'server',
    '线路测速与切换',
    '启动时并行测速，默认进入最快的线路；随时可以在「线路」里切换。',
  ],
];
const UPDATE_FEATURE = {
  desktop: [
    'download',
    '自动检查更新',
    '发现新版本后会提醒你，下载和安装由你自己完成。',
  ],
  mobile: [
    'download',
    '自动检查更新',
    'Android 下载 APK 覆盖安装；iOS 通过 AltStore 添加源后安装。',
  ],
};
const HERO_ICONS = {
  idle: 'refresh',
  checking: 'refresh',
  upToDate: 'checkCircle',
  available: 'zap',
  error: 'alert',
};
const STATUS_PILLS = {
  upToDate: ['pill-ok', '已是最新'],
  available: ['pill-info', '有新版本'],
  checking: ['pill-info', '检查中'],
  error: ['pill-danger', '检查失败'],
};
// 有新版本时的主按钮：图标和文字，按 describeUpdate 给出的 action 选择
const ACTION_BUTTONS = {
  download: ['download', '下载更新'],
  altstore: ['download', '添加到 AltStore'],
  release: ['external', '前往发布页'],
};
// 每个平台安装前的提示，显示在线路弹窗里
const INSTALL_TIPS = {
  macos:
    '下载后打开 .dmg，把 CKTV 拖进「应用程序」。首次打开如果提示无法验证开发者，到「系统设置 → 隐私与安全性」里点「仍要打开」。',
  windows:
    '下载后运行安装程序。出现 SmartScreen 提示时，点「更多信息」，再点「仍要运行」。',
  linux: '下载 AppImage 后，给文件加上执行权限（chmod +x），然后运行即可。',
  android:
    '下载 APK 后在通知栏或文件管理器里打开，允许安装即可覆盖安装。首次需要在系统设置里允许「安装未知应用」。',
  ios: '需要 AltStore 或 SideStore，用你自己的 Apple ID 签名安装。免费 Apple ID 的签名约 7 天需要在 AltStore 里刷新一次。',
};

const state = {
  app: null,
  settings: null,
  candidates: [],
  update: null,
  // 先用浏览器信息猜一下，读到真实平台后再修正
  mobile: /Android|iPhone|iPad/.test(navigator.userAgent),
  desktop: true,
  tab: 'update',
  checking: false,
  probing: false,
  probedAt: 0,
  probes: new Map(),
};

/* ================= 读取与刷新数据 ================= */

async function loadState() {
  const info = await invoke('bootstrap');
  state.app = info.app;
  state.settings = info.settings;
  state.candidates = info.candidates;
  state.update = info.update;
}

/** 改完设置后重新读取一遍，保证界面和原生层一致（比如候选线路顺序变了） */
async function refresh() {
  await loadState();
  renderAll();
}

/** 保存设置。失败时把开关等控件恢复成真实值。 */
async function saveSettings(patch) {
  try {
    await invoke('save_settings', { patch });
    await refresh();
    return true;
  } catch (error) {
    logError('保存设置失败', error);
    toast(errorText(error, '设置没有保存成功'), 'err');
    renderAll();
    return false;
  }
}

async function runCommand(command, args) {
  try {
    await invoke(command, args);
  } catch (error) {
    logError(`执行 ${command} 失败`, error);
    toast(errorText(error, '操作没有成功'), 'err');
  }
}

/* ================= 页面结构（只创建一次） ================= */

function buildPanels() {
  $('panel-update').append(
    h(
      'div',
      { class: 'grid-2' },
      h('section', { class: 'card', id: 'update-main' }),
      buildSettingsCard()
    )
  );
  $('panel-servers').append(buildServersPanel());
  $('panel-about').append(
    h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'card brand-card', id: 'about-brand' },
        buildBrandCard()
      ),
      h('section', { class: 'card', id: 'about-card' }),
      h('section', { class: 'card', id: 'about-features' }),
      h('section', { class: 'card', id: 'about-actions' }),
      h(
        'p',
        { class: 'about-foot' },
        'CKTV 原生客户端 · 更新信息来自 GitHub 发布清单 · 下载后可核对 SHA-256 校验值'
      )
    )
  );
}

/** 关于页顶部：品牌名、非盈利声明、内容说明 */
function buildBrandCard() {
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'brand-head' },
      h('img', {
        class: 'brand-logo',
        src: logoUrl,
        alt: '',
        width: 64,
        height: 64,
      }),
      h('div', { class: 'brand-name' }, 'CKTV 传康播放器')
    ),
    h(
      'ul',
      { class: 'chip-list', 'aria-label': PLEDGE.join('、') },
      PLEDGE.map((text) => h('li', { class: 'chip' }, text))
    ),
    pointList(BRAND_POINTS)
  );
}

function pointList(items) {
  return h(
    'ul',
    { class: 'point-list' },
    items.map(([iconName, text]) =>
      h(
        'li',
        null,
        h('span', { class: 'point-ico' }, icon(iconName, { size: 16 })),
        h('span', null, text)
      )
    )
  );
}

/** 客户端额外提供的功能。更新方式因平台不同，最后一项按当前平台给出。 */
function featureCard(desktop) {
  const update = desktop ? UPDATE_FEATURE.desktop : UPDATE_FEATURE.mobile;
  return h(
    'div',
    null,
    h('div', { class: 'card-title' }, '客户端额外提供的功能'),
    h(
      'div',
      { class: 'card-sub' },
      '开场、断网提示、更新检查等，都是客户端自己提供的'
    ),
    h(
      'ul',
      { class: 'feature-list' },
      [...APP_FEATURES, update].map(([iconName, title, text]) =>
        h(
          'li',
          null,
          h('span', { class: 'point-ico' }, icon(iconName, { size: 16 })),
          h(
            'span',
            null,
            h('span', { class: 'feature-title' }, title),
            h('span', { class: 'feature-text' }, text)
          )
        )
      )
    )
  );
}

function buildSettingsCard() {
  const autoInput = h('input', {
    type: 'checkbox',
    id: 'set-auto',
    'aria-labelledby': 'set-auto-title',
    onchange: (event) =>
      saveSettings({ autoCheckUpdates: event.currentTarget.checked }),
  });
  const intervalSelect = h(
    'select',
    {
      class: 'select compact',
      id: 'set-interval',
      'aria-label': '检查频率',
      onchange: (event) =>
        saveSettings({ checkIntervalHours: Number(event.currentTarget.value) }),
    },
    INTERVAL_OPTIONS.map((hours) =>
      h('option', { value: String(hours) }, interval(hours))
    )
  );
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('div', { class: 'card-title' }, '自动更新'),
        h('div', { class: 'card-sub' }, '在后台悄悄检查，发现新版本才提醒')
      )
    ),
    h(
      'div',
      { class: 'setting-row' },
      h(
        'div',
        { class: 'setting-text' },
        h(
          'div',
          { class: 'setting-title', id: 'set-auto-title' },
          '自动检查更新'
        ),
        h('div', { class: 'setting-desc' }, '关闭后，只有你手动检查时才会联网')
      ),
      h(
        'label',
        { class: 'switch' },
        autoInput,
        h('span', { class: 'track' }, h('span', { class: 'thumb' }))
      )
    ),
    h(
      'div',
      { class: 'setting-row' },
      h(
        'div',
        { class: 'setting-text' },
        h('div', { class: 'setting-title' }, '检查频率'),
        h('div', { class: 'setting-desc' }, '两次自动检查之间的间隔')
      ),
      intervalSelect
    ),
    h(
      'div',
      { class: 'setting-row' },
      h(
        'div',
        { class: 'setting-text' },
        h('div', { class: 'setting-title' }, '跳过的版本'),
        h('div', { class: 'setting-desc', id: 'skip-desc' })
      ),
      h('div', { id: 'skip-slot' })
    )
  );
}

function buildServersPanel() {
  const input = h('input', {
    class: 'input',
    id: 'server-input',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'https://example.com',
    'aria-describedby': 'server-hint',
  });
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    setHint(DEFAULT_HINT);
  });
  const form = h(
    'form',
    { class: 'server-form', id: 'server-form', novalidate: true },
    input,
    h('button', { class: 'btn btn-primary', type: 'submit' }, '添加并测速'),
    h('p', { class: 'hint', id: 'server-hint' }, DEFAULT_HINT)
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    addServer();
  });
  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h(
          'div',
          null,
          h('div', { class: 'card-title' }, '线路列表'),
          h(
            'div',
            { class: 'card-sub' },
            '默认进入延迟最低的可用线路，也可以指定首选'
          )
        ),
        h(
          'button',
          {
            class: 'btn btn-sm',
            id: 'probe-btn',
            type: 'button',
            onclick: () => probeAll({ report: true }),
          },
          icon('refresh', { size: 15 }),
          '重新测速'
        )
      ),
      h('ul', {
        class: 'server-list',
        id: 'server-list',
        'aria-label': '线路列表',
      })
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-title' }, '添加自定义线路'),
      h(
        'div',
        { class: 'card-sub form-lead' },
        '适合备用域名或自建镜像，只保存在这台设备上。'
      ),
      form
    )
  );
}

/* ================= 更新：渲染 ================= */

function renderAll() {
  if (!state.update || !state.settings) return;
  renderHero();
  renderUpdatePanel();
  renderServerList();
  renderAbout();
}

function renderHero() {
  const hero = $('hero');
  const { update } = state;
  const view = describeUpdate(update);
  const checking = state.checking || update.status === 'checking';
  hero.dataset.tone = checking ? 'busy' : view.tone;

  const actions = [];
  if (update.status === 'available' && view.action) {
    const [iconName, label] = ACTION_BUTTONS[view.action];
    actions.push(
      h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () =>
            view.action === 'release'
              ? openExternal(update.releaseUrl)
              : startDownload(update),
        },
        icon(iconName, { size: 16 }),
        label
      )
    );
  }
  actions.push(
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        id: 'check-btn',
        disabled: checking,
        onclick: () => checkUpdate(),
      },
      icon('refresh', { size: 16, className: checking ? 'spin' : '' }),
      checking ? '检查中…' : '检查更新'
    )
  );

  fill(
    hero,
    h(
      'div',
      { class: 'orb' },
      icon(HERO_ICONS[update.status] ?? 'refresh', {
        size: 26,
        className: checking ? 'spin' : '',
      })
    ),
    h(
      'div',
      { class: 'hero-body' },
      h('div', { class: 'hero-title' }, view.title),
      h('div', { class: 'hero-sub' }, view.subtitle)
    ),
    h('div', { class: 'hero-actions' }, actions)
  );
}

function renderUpdatePanel() {
  const { update } = state;
  const hasLatest = Boolean(update.latestVersion) && update.status !== 'error';
  fill(
    $('update-main'),
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('div', { class: 'card-title' }, '版本与更新内容'),
        h(
          'div',
          { class: 'card-sub' },
          `上次检查：${relativeTime(update.checkedAt)}`
        )
      ),
      statusPill(update)
    ),
    h(
      'div',
      { class: 'versions' },
      versionPill('当前版本', displayVersion(update.currentVersion), false),
      hasLatest ? icon('chevronRight', { size: 16, className: 'arrow' }) : null,
      hasLatest
        ? versionPill('最新版本', displayVersion(update.latestVersion), true)
        : null
    ),
    update.status === 'available' && update.publishedAt
      ? h('p', { class: 'hint publish-date' }, `发布于 ${update.publishedAt}`)
      : null,
    update.status === 'available' && update.download?.sha256
      ? checksumRow(update.download.sha256)
      : null,
    notesSection(update) ?? emptyNote(update)
  );
  renderSettingsControls();
}

/** 没有更新内容时，用一句话说明当前状态 */
function emptyNote(update) {
  const text = {
    upToDate: '已经是最新版本，没有需要查看的更新内容。',
    error: '检查网络后，点一下「检查更新」再试一次。',
    idle: '还没有检查过更新，点一下「检查更新」即可。',
  }[update.status];
  return text ? h('p', { class: 'notes-empty' }, text) : null;
}

function statusPill(update) {
  const [tone, text] = STATUS_PILLS[update.status] ?? ['', '尚未检查'];
  return h('span', { class: `pill ${tone}`.trim() }, text);
}

function versionPill(label, value, latest) {
  return h(
    'div',
    { class: `version-pill${latest ? ' latest' : ''}` },
    h('small', null, label),
    h('strong', null, value || '—')
  );
}

function checksumRow(checksum) {
  return h(
    'div',
    { class: 'checksum' },
    h('span', { class: 'hint' }, 'SHA-256'),
    h('code', null, checksum),
    h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onclick: async () => {
          const ok = await copyText(checksum);
          toast(ok ? '校验码已复制' : '复制没有成功', ok ? 'ok' : 'err');
        },
      },
      icon('copy', { size: 14 }),
      '复制'
    )
  );
}

function notesSection(update) {
  if (update.status !== 'available') return null;
  const blocks = parseNotes(update.notes);
  return h(
    'div',
    null,
    h('div', { class: 'notes-title' }, '更新内容'),
    blocks.length
      ? h('div', { class: 'notes' }, blocks.map(renderBlock))
      : h('p', { class: 'notes-empty' }, '这个版本没有填写更新说明。')
  );
}

/** 把解析好的更新说明变成元素。只创建元素和文字节点，不解析 HTML。 */
function renderBlock(block) {
  if (block.type === 'h')
    return h(`h${block.level}`, null, inlineNodes(block.inline));
  if (block.type === 'ul')
    return h(
      'ul',
      null,
      block.items.map((item) => h('li', null, inlineNodes(item)))
    );
  return h('p', null, inlineNodes(block.inline));
}

function inlineNodes(parts) {
  return parts.map((part) => {
    if (part.type === 'strong') return h('strong', null, part.text);
    if (part.type === 'code') return h('code', null, part.text);
    if (part.type === 'link') {
      return h(
        'a',
        {
          href: part.href,
          rel: 'noreferrer noopener',
          onclick: (event) => {
            event.preventDefault();
            openExternal(part.href);
          },
        },
        part.text
      );
    }
    return document.createTextNode(part.text);
  });
}

function renderSettingsControls() {
  const { update, settings } = state;
  $('set-auto').checked = settings.autoCheckUpdates;
  $('set-interval').value = String(settings.checkIntervalHours);

  const latest = update.status === 'available' ? update.latestVersion : null;
  const skipped = settings.skippedVersion;
  $('skip-desc').textContent =
    latest && skipped === latest
      ? `已跳过 ${displayVersion(latest)}，之后的新版本会照常提醒`
      : skipped
      ? `已跳过 ${displayVersion(skipped)}`
      : '跳过后，这个版本不会再弹出提醒';

  const slot = clear($('skip-slot'));
  if (latest && skipped !== latest) {
    slot.append(
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => saveSettings({ skippedVersion: latest }),
        },
        `跳过 ${displayVersion(latest)}`
      )
    );
  } else if (skipped) {
    slot.append(
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => saveSettings({ skippedVersion: null }),
        },
        '恢复提醒'
      )
    );
  }
}

/* ================= 更新：操作 ================= */

async function checkUpdate({ silent = false } = {}) {
  if (state.checking) return;
  state.checking = true;
  renderHero();
  try {
    const next = await invoke('check_update', { manual: !silent });
    state.update = next;
    renderAll();
    if (!silent) reportCheck(next);
  } catch (error) {
    logError('检查更新失败', error);
    if (!silent) toast(errorText(error, '检查更新没有成功'), 'err');
  } finally {
    state.checking = false;
    renderHero();
  }
}

function reportCheck(update) {
  if (update.status === 'available')
    toast(`发现新版本 ${displayVersion(update.latestVersion)}`, 'info');
  else if (update.status === 'upToDate') toast('已经是最新版本', 'ok');
  else if (update.status === 'error')
    toast(update.error || '检查更新没有成功', 'err');
}

/* ================= 下载与线路选择 ================= */

/** 点「下载」：海外用户直接打开 GitHub；其它情况弹窗让用户选线路 */
function startDownload(update) {
  if (!update.download) return;
  if (downloadAction(update) === 'direct') {
    openExternal(update.download.url);
    return;
  }
  openChooser(update);
}

/** 线路弹窗（<dialog>）只创建一次，每次打开时重新填内容 */
let chooser = null;

function buildChooser() {
  const dialog = h(
    'dialog',
    { class: 'chooser', id: 'chooser', 'aria-labelledby': 'chooser-title' },
    h(
      'div',
      { class: 'chooser-inner' },
      h(
        'div',
        { class: 'chooser-head' },
        h(
          'h2',
          { class: 'chooser-title', id: 'chooser-title' },
          '选择下载线路'
        ),
        h(
          'button',
          {
            class: 'btn btn-ghost btn-icon',
            type: 'button',
            'aria-label': '关闭',
            onclick: closeChooser,
          },
          icon('xCircle', { size: 18 })
        )
      ),
      h('div', { id: 'chooser-body' })
    )
  );
  // 点在弹窗外面的遮罩上，也关闭
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeChooser();
  });
  document.body.append(dialog);
  return dialog;
}

function openChooser(update) {
  const dialog = chooser ?? (chooser = buildChooser());
  fill($('chooser-body'), chooserBody(update));
  // 老版本的 WebView 没有 showModal 时，退回普通的 open 属性
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeChooser() {
  if (!chooser) return;
  if (typeof chooser.close === 'function') chooser.close();
  else chooser.removeAttribute('open');
}

function leadText(update) {
  const mirrors = mirrorUrlList(update.download);
  if (update.region === 'cn') {
    return mirrors.length
      ? `检测到你在中国大陆，已推荐国内线路（共 ${mirrors.length} 条可选）。`
      : '检测到你在中国大陆。';
  }
  if (update.region === 'other') return '推荐使用海外线路（GitHub）。';
  return mirrors.length
    ? `没有判断出你所在的位置，请选择一条线路（含 ${mirrors.length} 条国内加速）。`
    : '没有判断出你所在的位置，请选择一条线路。';
}

function chooserBody(update) {
  const { download, platform, releaseUrl } = update;
  const ios = platform === 'ios';
  const { lines, recommended } = downloadLines(update);
  const size = download.size
    ? `${(download.size / 1024 / 1024).toFixed(1)} MB`
    : null;
  const noMirror =
    update.region === 'cn' && mirrorUrlList(download).length === 0;
  return [
    h('p', { class: 'chooser-lead' }, leadText(update)),
    h(
      'div',
      { class: 'chooser-file' },
      icon('download', { size: 15 }),
      h('span', null, download.label),
      size ? h('span', { class: 'hint' }, size) : null
    ),
    noMirror
      ? h(
          'p',
          { class: 'notice' },
          icon('alert', { size: 16 }),
          h(
            'span',
            null,
            '国内线路暂未提供。GitHub 在部分网络下可能很慢或打不开，可以稍后再试。'
          )
        )
      : null,
    ios && download.sourceUrl ? altstoreSection(download.sourceUrl) : null,
    h(
      'h3',
      { class: 'chooser-sub' },
      ios ? '方法二：直接下载安装包' : '下载线路'
    ),
    h(
      'ul',
      { class: 'line-list' },
      lines.map((line) => lineItem(line, line.key === recommended))
    ),
    h(
      'p',
      { class: 'hint' },
      '下载失败或速度很慢时，不用重新检查更新，直接点另一条线路重试。'
    ),
    h('p', { class: 'hint install-tip' }, INSTALL_TIPS[platform] ?? ''),
    releaseUrl
      ? h(
          'button',
          {
            class: 'btn btn-ghost btn-sm chooser-release',
            type: 'button',
            onclick: () => {
              closeChooser();
              openExternal(releaseUrl);
            },
          },
          icon('external', { size: 14 }),
          '查看发布页（全部文件）'
        )
      : null,
  ];
}

/** iOS：AltStore 源地址，复制后在 AltStore 里添加即可 */
function altstoreSection(sourceUrl) {
  return h(
    'section',
    { class: 'altstore' },
    h('h3', { class: 'chooser-sub' }, '方法一：通过 AltStore 安装（推荐）'),
    h(
      'p',
      { class: 'hint' },
      '在电脑或 iPhone 上打开 AltStore，添加下面的源地址，之后可以直接安装和更新。'
    ),
    h(
      'div',
      { class: 'copy-row' },
      h('code', { class: 'copy-code' }, sourceUrl),
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          onclick: async () => {
            const ok = await copyText(sourceUrl);
            toast(
              ok
                ? '源地址已复制，到 AltStore 里添加即可'
                : '复制没有成功，请手动复制',
              ok ? 'ok' : 'err'
            );
          },
        },
        icon('copy', { size: 14 }),
        '复制源地址'
      )
    )
  );
}

function lineItem(line, recommended) {
  return h(
    'li',
    { class: `line-item${recommended ? ' recommended' : ''}` },
    h(
      'div',
      { class: 'line-main' },
      h(
        'div',
        { class: 'line-title' },
        line.title,
        recommended ? h('span', { class: 'pill pill-ok' }, '推荐') : null
      ),
      h('div', { class: 'line-hint' }, line.hint)
    ),
    h(
      'button',
      {
        class: `btn${recommended ? ' btn-primary' : ''}`,
        type: 'button',
        // 点了线路不关弹窗：这条线下载失败或太慢时，直接点另一条线重试，
        // 不用重新检查更新。下载成功后用右上角的关闭按钮关掉即可。
        onclick: () => {
          openExternal(line.url);
        },
      },
      icon('download', { size: 16 }),
      '下载'
    )
  );
}

/* ================= 线路 ================= */

function setHint(text, isError = false) {
  const hint = $('server-hint');
  hint.textContent = text;
  hint.classList.toggle('error', isError);
}

function ensureProbed() {
  if (!state.probing && Date.now() - state.probedAt > PROBE_TTL_MS) probeAll();
}

async function probeAll({ report = false } = {}) {
  if (state.probing) return;
  state.probing = true;
  const restore = busy($('probe-btn'), '测速中…');
  renderServerList();
  try {
    const results = await invoke('probe_servers');
    state.probes = new Map(results.map((probe) => [probe.url, probe]));
    state.probedAt = Date.now();
    if (report) {
      const usable = results.filter((probe) => probe.ok).length;
      toast(
        usable
          ? `测速完成，${usable} 条线路可用`
          : '测速完成，所有线路都暂时连不上',
        usable ? 'ok' : 'err'
      );
    }
  } catch (error) {
    logError('测速失败', error);
    toast(errorText(error, '测速失败'), 'err');
  } finally {
    state.probing = false;
    restore();
    renderServerList();
  }
}

async function probeUrls(urls) {
  const results = await invoke('probe_servers', { urls });
  for (const probe of results) state.probes.set(probe.url, probe);
  renderServerList();
  return results[0];
}

function renderServerList() {
  const list = $('server-list');
  if (!list || !state.settings) return;
  const fastest = pickBestServer([...state.probes.values()], null);
  list.setAttribute('aria-busy', String(state.probing));
  if (state.candidates.length === 0) {
    fill(
      list,
      h(
        'li',
        { class: 'item' },
        h(
          'span',
          { class: 'item-main' },
          h('span', { class: 'item-sub' }, '还没有可用的线路')
        )
      )
    );
    return;
  }
  fill(list, ...state.candidates.map((url) => serverItem(url, fastest)));
}

function serverItem(url, fastest) {
  const { settings } = state;
  const probe = state.probes.get(url);
  const custom = settings.customServers.includes(url);
  const preferred = settings.preferredServer === url;

  const tags = [];
  if (preferred) tags.push(h('span', { class: 'pill pill-info' }, '首选'));
  if (url === fastest) tags.push(h('span', { class: 'pill pill-ok' }, '最快'));
  if (url === settings.lastGoodServer)
    tags.push(h('span', { class: 'pill' }, '上次进入'));
  tags.push(h('span', { class: 'pill' }, custom ? '自定义' : '官方'));

  const tone =
    probe && !probe.ok
      ? 'danger'
      : probe && latencyTone(probe) === 'warn'
      ? 'warn'
      : '';
  const fill = !probe
    ? 0
    : probe.ok
    ? Math.max(8, 100 - Math.min(probe.latencyMs ?? 1000, 1000) / 10)
    : 100;

  const actions = [
    h(
      'button',
      {
        class: 'radio-pill',
        type: 'button',
        role: 'radio',
        'aria-checked': String(preferred),
        title: preferred ? '取消首选' : '设为首选',
        onclick: () => togglePreferred(url),
      },
      preferred ? '首选 ✓' : '设为首选'
    ),
  ];
  if (probe?.ok) {
    actions.push(
      h(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          title: `进入 ${hostOf(url)}`,
          onclick: () => enterServer(url),
        },
        icon('play', { size: 13 }),
        '进入'
      )
    );
  }
  if (custom) {
    actions.push(
      h(
        'button',
        {
          class: 'btn btn-ghost btn-sm btn-icon',
          type: 'button',
          title: '删除这条线路',
          'aria-label': `删除 ${hostOf(url)}`,
          onclick: () => removeServer(url),
        },
        icon('trash', { size: 15 })
      )
    );
  }

  const label = !probe && state.probing ? '测速中…' : latencyLabel(probe);
  return h(
    'li',
    { class: `server-item${preferred ? ' selected' : ''}` },
    h(
      'div',
      { class: 'server-main' },
      h('div', { class: 'server-host', title: url }, hostOf(url)),
      h('div', { class: 'server-tags' }, tags)
    ),
    h(
      'div',
      { class: 'latency' },
      h('span', { class: 'latency-value' }, label),
      h(
        'div',
        { class: `latency-bar${tone ? ` ${tone}` : ''}` },
        h('span', { style: { width: `${fill}%` } })
      )
    ),
    h('div', { class: 'server-btns' }, actions)
  );
}

async function togglePreferred(url) {
  const next = state.settings.preferredServer === url ? null : url;
  if (await saveSettings({ preferredServer: next })) {
    toast(next ? `已设为首选：${hostOf(url)}` : '已取消首选线路', 'ok');
  }
}

async function removeServer(url) {
  const rest = state.settings.customServers.filter((item) => item !== url);
  if (await saveSettings({ customServers: rest })) {
    state.probes.delete(url);
    toast(`已删除 ${hostOf(url)}`, 'ok');
  }
}

async function addServer() {
  const input = $('server-input');
  let url;
  try {
    url = normalizeServerInput(input.value);
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    setHint(errorText(error), true);
    input.focus();
    return;
  }
  if (state.candidates.includes(url)) {
    input.setAttribute('aria-invalid', 'true');
    setHint('这条线路已经在列表里了', true);
    return;
  }

  const restore = busy(
    $('server-form').querySelector('button[type="submit"]'),
    '添加中…'
  );
  try {
    await invoke('save_settings', {
      patch: { customServers: [...state.settings.customServers, url] },
    });
    await refresh();
    input.value = '';
    const probe = await probeUrls([url]);
    if (probe?.ok) {
      setHint(`已添加，${hostOf(url)} 可以连接`);
    } else {
      setHint(`已添加，但暂时连不上：${probe?.error ?? '未知原因'}`, true);
    }
    toast(`已添加 ${hostOf(url)}`, 'ok');
  } catch (error) {
    logError('添加线路失败', error);
    setHint(errorText(error), true);
    input.setAttribute('aria-invalid', 'true');
  } finally {
    restore();
  }
}

async function enterServer(url) {
  toast(`正在进入 ${hostOf(url)}`, 'info', 1800);
  await runCommand('open_server', { url });
}

/* ================= 关于 ================= */

function renderAbout() {
  const { app, update, settings } = state;
  if (!app) return;
  const facts = [
    ['版本', `v${app.version}${app.debug ? '（调试版）' : ''}`],
    ['平台', `${platformLabel(app.platform)} · ${app.arch}`],
    [
      '自动检查',
      settings.autoCheckUpdates
        ? `开启 · ${interval(settings.checkIntervalHours)}`
        : '已关闭',
    ],
    ['上次检查', relativeTime(update.checkedAt)],
  ];
  fill(
    $('about-card'),
    h(
      'div',
      { class: 'card-head' },
      h(
        'div',
        null,
        h('div', { class: 'card-title' }, 'CKTV 原生客户端'),
        h('div', { class: 'card-sub' }, '同一套界面，覆盖桌面与手机')
      ),
      h('img', {
        class: 'about-logo',
        src: logoUrl,
        alt: '',
        width: 44,
        height: 44,
      })
    ),
    h(
      'dl',
      { class: 'kv' },
      facts.map(([key, value]) =>
        h('div', null, h('dt', null, key), h('dd', null, value))
      )
    )
  );

  const rows = [
    state.desktop &&
      actionRow(
        'folder',
        '打开日志文件夹',
        '排查问题时，把这里的日志发给我们',
        () => runCommand('open_logs_dir')
      ),
    actionRow(
      'copy',
      '复制诊断信息',
      '包含版本、线路和更新状态，方便反馈',
      copyDiagnostics
    ),
    actionRow('external', '反馈问题', '到 GitHub 提交问题', () =>
      openExternal(LINKS.feedback)
    ),
    actionRow('globe', '访问官网', hostOf(LINKS.site), () =>
      openExternal(LINKS.site)
    ),
    actionRow(
      'code',
      '查看源代码',
      'GitHub 开源仓库，代码以 MIT 许可发布',
      () => openExternal(LINKS.repo)
    ),
    state.desktop &&
      actionRow('power', '重新启动应用', '关闭并重新打开全部窗口', () =>
        runCommand('restart_app')
      ),
  ].filter(Boolean);
  fill($('about-features'), featureCard(state.desktop));
  fill($('about-actions'), h('ul', { class: 'action-list' }, rows));
}

function actionRow(iconName, title, sub, onPress) {
  return h(
    'li',
    null,
    h(
      'button',
      { class: 'action-row', type: 'button', onclick: () => onPress() },
      h('span', { class: 'ico' }, icon(iconName, { size: 17 })),
      h('span', { class: 'label' }, title, h('span', { class: 'sub' }, sub)),
      icon('chevronRight', { size: 16, className: 'chev' })
    )
  );
}

async function copyDiagnostics() {
  try {
    const info = await invoke('diagnostics');
    const ok = await copyText(formatDiagnostics(info));
    toast(
      ok ? '诊断信息已复制，可以粘贴到反馈里' : '复制没有成功，请稍后再试',
      ok ? 'ok' : 'err'
    );
  } catch (error) {
    logError('生成诊断信息失败', error);
    toast(errorText(error, '生成诊断信息失败'), 'err');
  }
}

function formatDiagnostics({ app, settings, update, candidates, logDir }) {
  const lines = [
    'CKTV 诊断信息',
    `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `版本：${app.version}${app.debug ? '（调试版）' : ''}`,
    `平台：${platformLabel(app.platform)} · ${app.arch}`,
    `更新状态：${update.status}，当前 ${update.currentVersion}${
      update.latestVersion ? `，最新 ${update.latestVersion}` : ''
    }`,
    update.error ? `更新错误：${update.error}` : null,
    `自动检查：${
      settings.autoCheckUpdates
        ? `开启，${interval(settings.checkIntervalHours)}`
        : '关闭'
    }`,
    `首选线路：${settings.preferredServer ?? '无'}`,
    `上次进入：${settings.lastGoodServer ?? '无'}`,
    '线路列表：',
    ...candidates.map((url) => `  - ${url}`),
    logDir ? `日志目录：${logDir}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

/* ================= 标签页、窗口与键盘 ================= */

function switchTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) return;
  state.tab = name;
  for (const tab of TABS) {
    const active = tab === name;
    const button = $(`tab-${tab}`);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`panel-${tab}`).hidden = !active;
  }
  if (focus) $(`tab-${name}`).focus();
  if (name === 'servers') ensureProbed();
}

function onTabKey(event) {
  const index = TABS.indexOf(state.tab);
  const next = {
    ArrowRight: TABS[(index + 1) % TABS.length],
    ArrowLeft: TABS[(index + TABS.length - 1) % TABS.length],
    Home: TABS[0],
    End: TABS[TABS.length - 1],
  }[event.key];
  if (!next) return;
  event.preventDefault();
  switchTab(next, { focus: true });
}

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

async function goHome() {
  if (!inTauri) {
    location.href = 'index.html';
    return;
  }
  await runCommand('open_home');
}

function onKeydown(event) {
  if (!state.desktop) return;
  // 弹窗打开时，Esc 只关闭弹窗，不关闭整个更新中心
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

function applyChrome() {
  $('titlebar').hidden = !state.desktop;
  $('topbar').hidden = state.desktop;
  if (state.desktop) {
    $('tb-min').addEventListener('click', () => windowAction('minimize'));
    $('tb-close').addEventListener('click', () => windowAction('close'));
  } else {
    fill($('back'), icon('arrowLeft', { size: 20 }));
    $('back').addEventListener('click', goHome);
  }
}

function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });
  document.querySelector('.segmented').addEventListener('keydown', onTabKey);
  window.addEventListener('cktv:tab', (event) => switchTab(event.detail));
  document.addEventListener('keydown', onKeydown);
  listen('update-state', (payload) => {
    state.update = payload;
    renderAll();
  }).catch((error) => logError('监听更新状态失败', error));
}

/* ================= 启动 ================= */

async function init() {
  buildPanels();
  bindEvents();
  try {
    await loadState();
  } catch (error) {
    logError('读取更新信息失败', error);
    state.update = {
      status: 'error',
      platform: '',
      currentVersion: '',
      latestVersion: null,
      notes: null,
      publishedAt: null,
      download: null,
      releaseUrl: null,
      region: 'unknown',
      skipped: false,
      error: errorText(error, '无法读取更新信息'),
      checkedAt: null,
    };
    toast('无法读取应用信息，请重新打开更新中心', 'err', 4000);
  }
  if (state.app) state.mobile = Boolean(state.app.mobile);
  state.desktop = !state.mobile;
  applyPlatform(state.app);
  applyChrome();
  renderAll();

  const requested = new URLSearchParams(location.search).get('tab');
  switchTab(TABS.includes(requested) ? requested : 'update');

  // 打开时顺便检查一次；10 分钟内检查过就不重复联网
  const checkedAt = state.update?.checkedAt;
  if (state.app && (!checkedAt || Date.now() - checkedAt > CHECK_TTL_MS)) {
    checkUpdate({ silent: true });
  }
}

init();
