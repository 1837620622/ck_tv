// 时间和数字的显示格式

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 「刚刚」「5 分钟前」「3 小时前」「昨天」「2026-11-01」 */
export function relativeTime(timestamp, now = Date.now()) {
  if (!timestamp) return '从未';
  const diff = now - timestamp;
  if (diff < 0) return '刚刚';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return '昨天';
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}`;
}

export function percent(value) {
  if (value == null || Number.isNaN(value)) return '';
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

/** 检查频率的显示文字：6 → 每 6 小时，24 → 每天，168 → 每周 */
export function interval(hours) {
  if (hours >= 168) return '每周';
  if (hours === 24) return '每天';
  return `每 ${hours} 小时`;
}
