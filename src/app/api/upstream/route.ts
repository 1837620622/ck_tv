import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getSearchApiSites } from '@/lib/config';
import { viewerLine } from '@/lib/line';
import { clientIp, isCrossSite, takeQuota } from '@/lib/request-guard';
import {
  readSourceWatch,
  scheduleSourceWatch,
  SourceWatch,
  watchBatch,
} from '@/lib/source-watch';

export const runtime = 'edge';

function present(watch: SourceWatch | null) {
  const sources = watch?.sources || [];
  return {
    checkedAt: watch?.checkedAt || 0,
    ok: sources.filter((item) => item.ok).length,
    down: sources.filter((item) => !item.ok).length,
    changed: sources.filter((item) => item.changed).length,
    sources: sources.map((item) => ({
      key: item.key,
      name: item.name,
      ok: item.ok,
      ms: item.ms,
      changed: item.changed,
      latest: item.samples.slice(0, 3).map((sample) => ({
        title: sample.title,
        remarks: sample.remarks,
        time: sample.time,
        typeName: sample.typeName,
      })),
    })),
  };
}

// 巡检普通片源的最新列表。不返回采集地址。
// 这次请求只排一小批到后台，不等探活结束。
export async function GET(request: Request) {
  if (isCrossSite(request)) {
    return NextResponse.json(
      { error: '不允许跨站调用' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const ip = clientIp(request);
  if (ip) {
    const wait = takeQuota(`upstream:${ip}`, 30, 60_000);
    if (wait > 0) {
      return NextResponse.json(
        { error: '请求太频繁，请稍后再试' },
        { status: 429, headers: { 'Retry-After': String(wait) } }
      );
    }
  }

  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const sites = await getSearchApiSites(viewerLine(request));
  scheduleSourceWatch(watchBatch(sites), ctx);
  const watch = await readSourceWatch();
  return NextResponse.json(present(watch), {
    headers: {
      'Cache-Control': 'private, max-age=60',
      'CDN-Cache-Control': 'no-store',
    },
  });
}
