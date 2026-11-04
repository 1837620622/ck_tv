import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextResponse } from 'next/server';

import { jsonCacheHeaders, readJsonCache, writeJsonCache } from '@/lib/edge-cache';

export const runtime = 'edge';

const REPO = '1837620622/ck_tv';
// 目标固定，只查本仓库的最新正式发布，不接受外部传入的地址。
const GITHUB_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ALTSTORE_SOURCE = `https://github.com/${REPO}/releases/latest/download/altstore.json`;
// 边缘缓存 5 分钟：上游无鉴权限速 60 次/小时，这个间隔最多 12 次/小时，不会撞限。
// 浏览器缓存 60 秒：同一个人短时间内反复打开首页不重复请求。
const CACHE_SECONDS = 300;
const BROWSER_SECONDS = 60;
const FETCH_TIMEOUT_MS = 5000;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

// 首页下载卡片的同源接口：服务端去查最新发布，浏览器不用直连 api.github.com。
// 这样访客网络屏蔽 GitHub API 时卡片仍能显示最新版本号和直链；
// 失败时卡片回落到直连 api.github.com，再失败就指向 Release 页面（那里永远是最新版）。
export async function GET() {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();

  const cacheUrl = 'https://cktv-cache.local/latest-release?v=1';
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    return new NextResponse(await hit.text(), {
      headers: {
        ...jsonCacheHeaders(CACHE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'HIT',
      },
    });
  }

  try {
    const response = await fetch(GITHUB_LATEST_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cktv-web',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return NextResponse.json(
        { ok: false, reason: `github-${response.status}` },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const data = (await response.json()) as GithubRelease;
    if (!data?.tag_name || !Array.isArray(data.assets)) {
      return NextResponse.json(
        { ok: false, reason: 'bad-payload' },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    const android = data.assets.find((asset) =>
      asset.name.endsWith('_android.apk')
    );
    const body = JSON.stringify({
      ok: true,
      tag: data.tag_name,
      androidUrl: android ? android.browser_download_url : null,
      releaseUrl: data.html_url || RELEASES_PAGE,
      altstoreUrl: ALTSTORE_SOURCE,
    });
    await writeJsonCache(ctx, cacheUrl, body, CACHE_SECONDS, BROWSER_SECONDS);
    return new NextResponse(body, {
      headers: {
        ...jsonCacheHeaders(CACHE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'MISS',
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return NextResponse.json(
      { ok: false, reason: timedOut ? 'timeout' : 'network' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
