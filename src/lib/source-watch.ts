// 巡检 config.json 里已经配置的普通源。
// 地址还是各源自己的苹果 CMS，只改成列表动作，不拉播放地址。
// 挂掉的源让出搜索的快速名额；列表指纹变了就记成这个源有更新。

import { readJsonCache, writeJsonCache } from '@/lib/edge-cache';
import { isAdultContent, isUnderageLabel } from '@/lib/yellow';

const WATCH_URL = 'https://cktv-cache.local/source-watch?v=1';
// 一刻钟内不重复探活。缓存留得更久，过期前仍能知道哪些源上次不通。
const FRESH_SECONDS = 900;
const CACHE_SECONDS = 1800;
const PROBE_TIMEOUT_MS = 2200;
const SAMPLE_LIMIT = 6;

const LIST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export interface WatchSite {
  key: string;
  name: string;
  api: string;
}

export interface SourceSample {
  id: string;
  title: string;
  remarks: string;
  time: string;
  typeName: string;
}

export interface SourceStatus {
  key: string;
  name: string;
  ok: boolean;
  ms: number;
  fingerprint: string;
  changed: boolean;
  samples: SourceSample[];
}

export interface SourceWatch {
  checkedAt: number;
  sources: SourceStatus[];
}

type WaitCtx = {
  waitUntil(promise: Promise<unknown>): void;
};

interface ListRow {
  vod_id?: string | number;
  vod_name?: string;
  vod_remarks?: string;
  vod_time?: string;
  type_name?: string;
  vod_class?: string;
}

let inflight: Promise<void> | null = null;

export function listEndpoint(api: string): string {
  const base = api.trim().replace(/[?&]+$/, '');
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}ac=list&pg=1`;
}

function clip(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function parseListPayload(data: unknown): SourceSample[] {
  const list = (data as { list?: unknown } | null)?.list;
  if (!Array.isArray(list)) return [];
  const samples: SourceSample[] = [];
  for (const row of list as ListRow[]) {
    if (samples.length >= SAMPLE_LIMIT) break;
    const id = clip(row?.vod_id, 32);
    const title = clip(row?.vod_name, 80);
    const typeName = clip(row?.type_name, 20);
    const category = clip(row?.vod_class, 40);
    if (!id || !title) continue;
    if (isUnderageLabel(`${title} ${typeName} ${category}`)) continue;
    if (isAdultContent({ title, type_name: typeName, class: category })) {
      continue;
    }
    const remarks = clip(row?.vod_remarks, 40);
    samples.push({
      id,
      title,
      remarks: remarks.includes('http') ? '' : remarks,
      time: clip(row?.vod_time, 32),
      typeName,
    });
  }
  return samples;
}

export function fingerprintOf(samples: SourceSample[]): string {
  return samples
    .map((item) => `${item.id}|${item.time}|${item.remarks}`)
    .join('\n');
}

export function withChanges(
  previous: SourceStatus[] | undefined,
  next: SourceStatus[]
): SourceStatus[] {
  const prev = new Map((previous || []).map((item) => [item.key, item]));
  return next.map((item) => {
    const old = prev.get(item.key);
    const changed = Boolean(
      item.ok &&
        old?.ok &&
        old.fingerprint &&
        item.fingerprint &&
        old.fingerprint !== item.fingerprint
    );
    return { ...item, changed };
  });
}

// 搜索请求里只探一小批，避免和回源抢子请求。新鲜期内换下一批。
export function watchBatch(sites: WatchSite[], size = 6): WatchSite[] {
  if (sites.length <= size) return sites;
  const steps = Math.ceil(sites.length / size);
  const slot = Math.floor(Date.now() / (FRESH_SECONDS * 1000)) % steps;
  return sites.slice(slot * size, slot * size + size);
}

export function downSourceKeys(watch: SourceWatch | null): string[] {
  if (!watch) return [];
  return watch.sources.filter((item) => !item.ok).map((item) => item.key);
}

export async function readSourceWatch(): Promise<SourceWatch | null> {
  const hit = await readJsonCache(WATCH_URL);
  if (!hit) return null;
  try {
    const parsed = JSON.parse(await hit.text()) as SourceWatch;
    if (!parsed || !Array.isArray(parsed.sources)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function failedStatus(site: WatchSite, ms: number): SourceStatus {
  return {
    key: site.key,
    name: site.name,
    ok: false,
    ms,
    fingerprint: '',
    changed: false,
    samples: [],
  };
}

async function probeSite(site: WatchSite): Promise<SourceStatus> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(listEndpoint(site.api), {
      headers: LIST_HEADERS,
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    } as RequestInit);
    if (!response.ok) return failedStatus(site, Date.now() - started);
    const samples = parseListPayload(await response.json());
    return {
      key: site.key,
      name: site.name,
      ok: true,
      ms: Date.now() - started,
      fingerprint: fingerprintOf(samples),
      changed: false,
      samples,
    };
  } catch {
    return failedStatus(site, Date.now() - started);
  } finally {
    clearTimeout(timer);
  }
}

async function refreshWatch(
  sites: WatchSite[],
  previous: SourceWatch | null,
  ctx: WaitCtx | undefined
) {
  const seen = new Set<string>();
  const unique = sites.filter((site) => {
    if (!site.api || seen.has(site.key)) return false;
    seen.add(site.key);
    return true;
  });
  const probed = await Promise.all(unique.map((site) => probeSite(site)));
  const updated = withChanges(previous?.sources, probed);
  const probedKeys = new Set(updated.map((item) => item.key));
  // 这一轮没探到的源沿用上次结论，不能因为只探了一批就把其余源标掉。
  const kept = (previous?.sources || []).filter(
    (item) => !probedKeys.has(item.key)
  );
  const payload: SourceWatch = {
    checkedAt: Date.now(),
    sources: [...updated, ...kept],
  };
  await writeJsonCache(
    ctx,
    WATCH_URL,
    JSON.stringify(payload),
    CACHE_SECONDS,
    0,
    0
  );
}

// force 时忽略新鲜期，给定时任务用。进行中的一轮不会再开一轮。
export function beginSourceWatch(
  sites: WatchSite[],
  ctx?: WaitCtx,
  force = false
): Promise<void> {
  if (inflight) return inflight;
  // 完成后再清掉进行中的标记。闭包不能在 const 赋值完成前读到自己。
  const slot: { task: Promise<void> | null } = { task: null };
  const task = (async () => {
    try {
      const current = await readSourceWatch();
      const age = current ? (Date.now() - current.checkedAt) / 1000 : Infinity;
      if (!force && current && age < FRESH_SECONDS) return;
      await refreshWatch(sites, current, ctx);
    } finally {
      if (inflight === slot.task) inflight = null;
    }
  })();
  slot.task = task;
  inflight = task;
  return task;
}

// 搜索请求里调用：到点就在响应结束后接着探，不挡住这次搜索。
export function scheduleSourceWatch(sites: WatchSite[], ctx?: WaitCtx) {
  const task = beginSourceWatch(sites, ctx, false);
  if (ctx) ctx.waitUntil(task.catch(() => undefined));
}

// 要等这一轮写完再读结果时用。首页的状态接口不等它。
export async function loadSourceWatch(
  sites: WatchSite[],
  ctx?: WaitCtx
): Promise<SourceWatch | null> {
  const task = beginSourceWatch(sites, ctx, false);
  if (ctx) ctx.waitUntil(task.catch(() => undefined));
  await Promise.race([
    task.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  return readSourceWatch();
}
