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
// 陈旧兜底 7 天：上游 GitHub 挂了或限速时，返回上次成功的结果而不是 502；
// 卡片拿到带 stale 标记的结果会先显示它，再去直连 GitHub API 刷新，不会把旧版本当成最新。
const STALE_SECONDS = 7 * 24 * 3600;

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
  const staleUrl = `${cacheUrl}&stale=1`;
  // 上游失败时用上次成功的结果兜底；没有兜底才返回 502。
  const serveStale = async () => {
    const stale = await readJsonCache(staleUrl);
    if (!stale) return null;
    return new NextResponse(await stale.text(), {
      headers: {
        'Cache-Control': 'public, max-age=60, s-maxage=0',
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'STALE',
      },
    });
  };
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
      return (
        (await serveStale()) ??
        NextResponse.json(
          { ok: false, reason: `github-${response.status}` },
          { status: 502, headers: { 'Cache-Control': 'no-store' } }
        )
      );
    }
    const data = (await response.json()) as GithubRelease;
    if (!data?.tag_name || !Array.isArray(data.assets)) {
      return (
        (await serveStale()) ??
        NextResponse.json(
          { ok: false, reason: 'bad-payload' },
          { status: 502, headers: { 'Cache-Control': 'no-store' } }
        )
      );
    }
    const android = data.assets.find((asset) =>
      asset.name.endsWith('_android.apk')
    );
    const androidUrl = android ? android.browser_download_url : null;
    // 国内用户直连 GitHub 下载 APK 很慢或打不开时用的公开代理线路；
    // 只有 github.com 的地址才拼代理，其它地址不动。
    const androidMirrorUrl =
      androidUrl && androidUrl.startsWith('https://github.com/')
        ? `https://ghfast.top/${androidUrl}`
        : null;
    const payload = {
      ok: true,
      tag: data.tag_name,
      androidUrl,
      androidMirrorUrl,
      releaseUrl: data.html_url || RELEASES_PAGE,
      altstoreUrl: ALTSTORE_SOURCE,
    };
    const body = JSON.stringify(payload);
    await writeJsonCache(ctx, cacheUrl, body, CACHE_SECONDS, BROWSER_SECONDS);
    await writeJsonCache(
      ctx,
      staleUrl,
      JSON.stringify({ ...payload, stale: true }),
      STALE_SECONDS,
      BROWSER_SECONDS
    );
    return new NextResponse(body, {
      headers: {
        ...jsonCacheHeaders(CACHE_SECONDS, BROWSER_SECONDS),
        'content-type': 'application/json; charset=utf-8',
        'x-ck-cache': 'MISS',
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return (
      (await serveStale()) ??
      NextResponse.json(
        { ok: false, reason: timedOut ? 'timeout' : 'network' },
        { status: 502, headers: { 'Cache-Control': 'no-store' } }
      )
    );
  }
}
