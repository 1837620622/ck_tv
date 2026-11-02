// 线路（站点地址）的前端规则。Rust 端会再校验一遍，这里只是提前给用户看到错误。

export function normalizeServerInput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('请输入线路地址');
  const withScheme = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('线路地址格式不对');
  }
  if (url.protocol !== 'https:')
    throw new Error('线路地址必须以 https:// 开头');
  if (!url.hostname) throw new Error('线路地址缺少域名');
  if (url.username || url.password)
    throw new Error('线路地址不能包含账号和密码');
  return url.origin;
}

export function hostOf(address) {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/**
 * 从测速结果里选出要进入的线路：
 * 1. 用户设为首选、并且可用 → 用首选
 * 2. 否则选延迟最低的可用线路
 * 3. 全部不可用 → null
 */
export function pickBestServer(probes, preferred) {
  const usable = (probes ?? []).filter((probe) => probe.ok);
  if (preferred) {
    const match = usable.find((probe) => probe.url === preferred);
    if (match) return match.url;
  }
  if (usable.length === 0) return null;
  const sorted = [...usable].sort(
    (a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)
  );
  return sorted[0].url;
}

/** 延迟的等级，用来决定颜色：快 / 一般 / 慢 / 不可用 */
export function latencyTone(probe) {
  if (!probe || !probe.ok) return 'danger';
  return (probe.latencyMs ?? Infinity) < 350 ? 'ok' : 'warn';
}

export function latencyLabel(probe) {
  if (!probe) return '未测速';
  if (!probe.ok) return probe.error || '不可用';
  return `${probe.latencyMs} ms`;
}
