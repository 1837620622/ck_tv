// 把更新状态翻译成界面要显示的文字和操作。
// action 的含义：
// - download：下载安装包（是否弹窗选线路，由 download.js 决定）
// - altstore：iOS，通过 AltStore 添加源后安装
// - release：没有适合本机的安装包，只能到发布页查看
// - null：没有需要点的按钮

const PLATFORM_HINT = {
  macos: '下载后打开 .dmg，把 CKTV 拖进「应用程序」即可',
  windows: '下载安装程序，按提示覆盖安装即可',
  linux: '下载 AppImage，加上执行权限后运行即可',
  android: '下载 APK，允许安装后覆盖安装，一般不会丢失设置',
  ios: '通过 AltStore 添加源，之后可以直接安装和更新',
};

function versionText(version) {
  return version ? `v${String(version).replace(/^v/, '')}` : '';
}

function availableView(state) {
  const title = `发现新版本 ${versionText(state.latestVersion)}`.trim();
  if (!state.download) {
    return {
      tone: 'warn',
      title,
      subtitle: '这个平台暂时没有安装包，请到发布页查看',
      action: state.releaseUrl ? 'release' : null,
    };
  }
  const subtitle = state.skipped
    ? '你已跳过这个版本，需要时仍可以下载'
    : PLATFORM_HINT[state.platform] ?? '下载安装包后手动安装即可';
  return {
    tone: 'info',
    title,
    subtitle,
    action: state.platform === 'ios' ? 'altstore' : 'download',
  };
}

export function describeUpdate(state) {
  const status = state?.status ?? 'idle';

  switch (status) {
    case 'checking':
      return {
        tone: 'busy',
        title: '正在检查更新',
        subtitle: '请稍候…',
        action: null,
      };
    case 'upToDate':
      return {
        tone: 'ok',
        title: '已是最新版本',
        subtitle: `当前版本 ${versionText(state.currentVersion)}`,
        action: null,
      };
    case 'available':
      return availableView(state);
    case 'error':
      return {
        tone: 'danger',
        title: '检查更新没有成功',
        subtitle: state.error || '请稍后再试',
        action: null,
      };
    default:
      return {
        tone: 'idle',
        title: '还没有检查更新',
        subtitle: '点一下「检查更新」，看看有没有新版本',
        action: null,
      };
  }
}
