import { getOptionalRequestContext } from '@cloudflare/next-on-pages';
import { NextRequest, NextResponse } from 'next/server';

import {
  jsonCacheHeaders,
  readJsonCache,
  writeJsonCache,
} from '@/lib/edge-cache';
import { countryOf } from '@/lib/edge-country';

export const runtime = 'edge';

const REPO = '1837620622/ck_tv';
// 目标固定，只查本仓库的最新正式发布，不接受外部传入的地址。
const GITHUB_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ALTSTORE_SOURCE = `https://github.com/${REPO}/releases/latest/download/altstore.json`;
// 与客户端 update.rs / make-update-manifest.mjs 保持一致（2026-11-05 探测可用）
const GITHUB_PROXY_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  'https://edgeone.gh-proxy.com/',
] as const;
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

interface LatestCore {
  ok: true;
  tag: string;
  androidUrl: string | null;
  /** @deprecated 兼容旧前端：等于 mirrors[0] */
  androidMirrorUrl: string | null;
  mirrors: string[];
  releaseUrl: string;
  altstoreUrl: string;
  stale?: boolean;
}

function buildMirrors(androidUrl: string | null): string[] {
  if (!androidUrl) return [];
  // 官方国内源（若环境变量配置了 CN_MIRROR_BASE，发布清单会写进 update.json；
  // 这里只为 github.com 直链拼公开代理，不臆造 OSS 地址）
  if (!androidUrl.startsWith('https://github.com/')) return [];
  return GITHUB_PROXY_PREFIXES.map((prefix) => `${prefix}${androidUrl}`);
}

function withCountry(core: LatestCore, request: NextRequest) {
  const country = countryOf(request);
  const preferMirror = country === 'CN';
  return {
    ...core,
    country: country || null,
    preferMirror,
  };
}

function jsonResponse(
  body: string,
  cache: 'HIT' | 'MISS' | 'STALE',
  extraHeaders: Record<string, string> = {}
) {
  return new NextResponse(body, {
    headers: {
      ...jsonCacheHeaders(CACHE_SECONDS, BROWSER_SECONDS),
      'content-type': 'application/json; charset=utf-8',
      'x-ck-cache': cache,
      // 国家相关字段按请求计算，CDN 不要按无国家缓存串台
      Vary: 'CF-IPCountry',
      ...extraHeaders,
    },
  });
}

// 首页下载卡片的同源接口：服务端去查最新发布，浏览器不用直连 api.github.com。
// 这样访客网络屏蔽 GitHub API 时卡片仍能显示最新版本号和直链；
// 失败时卡片回落到直连 api.github.com，再失败就指向 Release 页面（那里永远是最新版）。
export async function GET(request: NextRequest) {
  const ctx = (() => {
    try {
      return getOptionalRequestContext()?.ctx;
    } catch {
      return undefined;
    }
  })();

  const cacheUrl = 'https://cktv-cache.local/latest-release?v=2';
  const staleUrl = `${cacheUrl}&stale=1`;
  // 上游失败时用上次成功的结果兜底；没有兜底才返回 502。
  const serveStale = async () => {
    const stale = await readJsonCache(staleUrl);
    if (!stale) return null;
    try {
      const core = (await stale.json()) as LatestCore;
      return jsonResponse(JSON.stringify(withCountry(core, request)), 'STALE', {
        'Cache-Control': 'public, max-age=60, s-maxage=0',
      });
    } catch {
      return null;
    }
  };
  const hit = await readJsonCache(cacheUrl);
  if (hit) {
    try {
      const core = (await hit.json()) as LatestCore;
      return jsonResponse(JSON.stringify(withCountry(core, request)), 'HIT');
    } catch {
      // 缓存损坏：掉到重新拉取
    }
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
    const mirrors = buildMirrors(androidUrl);
    const core: LatestCore = {
      ok: true,
      tag: data.tag_name,
      androidUrl,
      androidMirrorUrl: mirrors[0] ?? null,
      mirrors,
      releaseUrl: data.html_url || RELEASES_PAGE,
      altstoreUrl: ALTSTORE_SOURCE,
    };
    const body = JSON.stringify(core);
    await writeJsonCache(ctx, cacheUrl, body, CACHE_SECONDS, BROWSER_SECONDS);
    await writeJsonCache(
      ctx,
      staleUrl,
      JSON.stringify({ ...core, stale: true }),
      STALE_SECONDS,
      BROWSER_SECONDS
    );
    return jsonResponse(JSON.stringify(withCountry(core, request)), 'MISS');
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
