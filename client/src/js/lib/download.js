// 下载线路的选择规则（纯函数，便于测试）。
// - 海外用户（region 为 other）：直接打开 GitHub 下载，不弹窗。
// - 中国大陆用户（cn）和无法判断地区的用户（unknown）：弹窗让用户选线路。
//   中国大陆用户如果清单里配了国内线路，就推荐国内线路。
// - iOS 总是弹窗：要先在 AltStore 里添加源，弹窗里有源地址和复制按钮。

export const LINE_GITHUB = 'github';
export const LINE_MIRROR = 'mirror';

/** 点击「下载」后要做什么：none 没有安装包，direct 直接打开 GitHub，choose 弹窗选线路 */
export function downloadAction(update) {
  if (!update?.download) return 'none';
  if (update.platform !== 'ios' && update.region === 'other') return 'direct';
  return 'choose';
}

/**
 * 弹窗里的下载线路。lines 按显示顺序排列；recommended 是推荐的那条的 key，没有推荐时为 null。
 * 只有一条线路时不推荐（没有可选的余地）。
 */
export function downloadLines(update) {
  const download = update?.download;
  if (!download) return { lines: [], recommended: null };

  const github = {
    key: LINE_GITHUB,
    title: '海外线路（GitHub）',
    hint: '能正常访问 GitHub 的网络推荐',
    url: download.url,
  };
  if (!download.mirrorUrl) return { lines: [github], recommended: null };

  const mirror = {
    key: LINE_MIRROR,
    title: '国内线路',
    hint: '中国大陆网络推荐，无需海外网络',
    url: download.mirrorUrl,
  };
  if (update.region === 'cn') {
    return { lines: [mirror, github], recommended: LINE_MIRROR };
  }
  if (update.region === 'other') {
    return { lines: [github, mirror], recommended: LINE_GITHUB };
  }
  return { lines: [github, mirror], recommended: null };
}
