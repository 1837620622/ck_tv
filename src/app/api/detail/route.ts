import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { getAdultApiSites, getAvailableApiSites } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import {
  cacheAgeSeconds,
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { detailHuangguo } from '@/lib/huangguo';
import { gateDenyInit, PRIVATE_HEADERS } from '@/lib/region-gate';
import { DETAIL_CACHE_VERSION } from '@/lib/search-cache';

export const runtime = 'edge';

const DETAIL_EDGE_SECONDS = 60;
const DETAIL_BROWSER_SECONDS = 10;
const DETAIL_FRESH_SECONDS = 20;
const DETAIL_WAIT_MS = 500;

const detailInflight = new Map<string, Promise<void>>();

function startDetail(cacheUrl: string, work: () => Promise<void>) {
  if (detailInflight.has(cacheUrl)) return;
  let resolve: () => void;
  const task = new Promise<void>((done) => {
    resolve = done;
  });
  detailInflight.set(cacheUrl, task);
  void work()
    .catch(() => undefined)
    .finally(() => {
      detailInflight.delete(cacheUrl);
      resolve();
    });
}

export async function GET(request: Request) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  if (sourceCode === 'huangguo') {
    const denied = await gateDenyInit(request);
    if (denied) {
      return NextResponse.json(denied.body, {
        status: denied.status,
        headers: denied.headers,
      });
    }
    try {
      const result = await detailHuangguo(id);
      return NextResponse.json(result, {
        headers: {
          ...PRIVATE_HEADERS,
          'content-type': 'application/json; charset=utf-8',
        },
      });
    } catch (error) {
      return NextResponse.json(
        { error: (error as Error).message },
        { status: 404, headers: PRIVATE_HEADERS }
      );
    }
  }

  try {
    const apiSites = await getAvailableApiSites();
    let apiSite = apiSites.find((site) => site.key === sourceCode);

    let adultSource = false;
    if (!apiSite) {
      const adultSites = await getAdultApiSites();
      apiSite = adultSites.find((site) => site.key === sourceCode);
      adultSource = Boolean(apiSite);
    }

    if (adultSource) {
      const denied = await gateDenyInit(request);
      if (denied) {
        return NextResponse.json(denied.body, {
          status: denied.status,
          headers: denied.headers,
        });
      }
    }

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }
    const site = apiSite;

    const cacheUrl = `https://cktv-cache.local/detail?source=${encodeURIComponent(
      sourceCode
    )}&id=${encodeURIComponent(id)}&v=${DETAIL_CACHE_VERSION}`;
    const headersFor = (state: string) => ({
      ...(adultSource
        ? PRIVATE_HEADERS
        : jsonCacheHeaders(DETAIL_EDGE_SECONDS, DETAIL_BROWSER_SECONDS, 0)),
      'content-type': 'application/json; charset=utf-8',
      'x-ck-cache': state,
    });
    const refresh = async () => {
      const result = await getDetailFromApi(site, id);
      if (!result?.episodes?.length) return;
      await writeJsonCache(
        ctx,
        cacheUrl,
        JSON.stringify(result),
        DETAIL_EDGE_SECONDS,
        DETAIL_BROWSER_SECONDS,
        0
      );
    };
    const hit = await readJsonCache(cacheUrl);
    if (hit && !adultSource) {
      const age = cacheAgeSeconds(hit);
      const text = await hit.text();
      if (age >= DETAIL_FRESH_SECONDS) {
        startDetail(cacheUrl, refresh);
        const pending = detailInflight.get(cacheUrl);
        if (pending) ctx?.waitUntil(pending.catch(() => undefined));
        if (pending) {
          await Promise.race([
            pending.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, DETAIL_WAIT_MS)),
          ]);
          const newer = await readJsonCache(cacheUrl);
          if (newer) {
            return new NextResponse(await newer.text(), {
              headers: headersFor('FRESH'),
            });
          }
        }
      }
      return new NextResponse(text, { headers: headersFor('HIT') });
    }
    if (hit && adultSource) {
      return new NextResponse(await hit.text(), { headers: headersFor('HIT') });
    }

    const result = await getDetailFromApi(site, id);
    const body = JSON.stringify(result);
    if (!result?.episodes?.length) {
      return new NextResponse(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'x-ck-cache': 'EMPTY',
        },
      });
    }
    await writeJsonCache(
      ctx,
      cacheUrl,
      body,
      DETAIL_EDGE_SECONDS,
      DETAIL_BROWSER_SECONDS,
      0
    );

    return new NextResponse(body, {
      headers: headersFor('MISS'),
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
