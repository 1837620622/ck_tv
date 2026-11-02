// 版本号比较（语义化版本 semver）。无法解析的版本号一律当作「不是更新」，避免乱提示。

const PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
  const match = PATTERN.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

// 预发布标识符比较：数字按数值比较，字母按字典序；数字小于字母；有预发布的版本小于正式版
function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const aNum = /^\d+$/.test(a[i]);
    const bNum = /^\d+$/.test(b[i]);
    if (aNum && bNum) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff !== 0) return diff > 0 ? 1 : -1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] > b[i] ? 1 : -1;
    }
  }
  return 0;
}

export function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return comparePre(a.pre, b.pre);
}

/** latest 是否比 current 新。任一版本无法解析时返回 false。 */
export function isNewer(latest, current) {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  return compareVersions(l, c) > 0;
}

/** 统一显示成 v1.2.3 */
export function displayVersion(text) {
  const parsed = String(text ?? '')
    .trim()
    .replace(/^v/i, '');
  return parsed ? `v${parsed}` : '';
}
