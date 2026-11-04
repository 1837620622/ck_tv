'use client';

import { Download, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';

// 手机客户端的安装包都放在 GitHub Release 里。这里总是指向「最新的正式版本」：
// 每次打开页面都重新查最新发布：先走本站的 /api/latest（服务端查、边缘缓存 5 分钟，
// 访客不用直连 GitHub API），失败再直连 api.github.com，最后回落到 Release 页面，
// 那里永远列着最新版本，所以链接不会失效。
const REPO = '1837620622/ck_tv';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ALTSTORE_SOURCE = `https://github.com/${REPO}/releases/latest/download/altstore.json`;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface LatestRelease {
  tag_name: string;
  assets: ReleaseAsset[];
}

function findAsset(assets: ReleaseAsset[], suffix: string): string | null {
  const hit = assets.find((asset) => asset.name.endsWith(suffix));
  return hit ? hit.browser_download_url : null;
}

export default function MobileAppDownload() {
  const [release, setRelease] = useState<LatestRelease | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    (async () => {
      // 1) 本站接口：服务端查最新发布，访客网络屏蔽 GitHub API 时也能显示版本号
      try {
        const res = await fetch('/api/latest', { signal });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok && data.tag) {
            setRelease({
              tag_name: data.tag,
              assets: data.androidUrl
                ? [
                    {
                      name: 'CKTV_android.apk',
                      browser_download_url: data.androidUrl,
                    },
                  ]
                : [],
            });
            return;
          }
        }
      } catch {
        // 掉到下一级
      }
      // 2) 直连 GitHub API
      try {
        const res = await fetch(
          `https://api.github.com/repos/${REPO}/releases/latest`,
          {
            headers: { Accept: 'application/vnd.github+json' },
            signal,
          }
        );
        if (res.ok) {
          const data: LatestRelease = await res.json();
          if (data && Array.isArray(data.assets)) setRelease(data);
        }
      } catch {
        // 读取失败不影响页面：按钮已经指向 Release 页面
      }
    })();
    return () => controller.abort();
  }, []);

  const androidHref =
    (release && findAsset(release.assets, '_android.apk')) || RELEASES_PAGE;

  return (
    <section
      aria-labelledby='mobile-download-title'
      className='mb-8 rounded-xl border border-gray-200 bg-white p-4 sm:p-5 dark:border-gray-800 dark:bg-gray-900/60'
    >
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <Smartphone
          className='h-5 w-5 text-green-600 dark:text-green-400'
          aria-hidden
        />
        <h2
          id='mobile-download-title'
          className='text-base font-semibold text-gray-900 dark:text-gray-100'
        >
          手机客户端下载
        </h2>
        {release ? (
          <span className='text-xs text-gray-500 dark:text-gray-400'>
            最新版本 {release.tag_name}
          </span>
        ) : null}
      </div>

      <div className='grid gap-4 sm:grid-cols-2'>
        <div className='flex flex-col gap-3 rounded-lg border border-gray-100 p-4 dark:border-gray-800'>
          <div>
            <p className='font-medium text-gray-900 dark:text-gray-100'>
              安卓手机
            </p>
            <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
              下载 APK 后直接安装。首次安装时需要允许「安装未知来源应用」。
            </p>
          </div>
          <a
            href={androidHref}
            className='inline-flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700 sm:w-auto sm:self-start'
          >
            <Download className='h-4 w-4' aria-hidden />
            下载安卓版 APK
          </a>
        </div>

        <div className='flex flex-col gap-3 rounded-lg border border-gray-100 p-4 dark:border-gray-800'>
          <div>
            <p className='font-medium text-gray-900 dark:text-gray-100'>
              iPhone / iPad
            </p>
            <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
              安装包未签名，需要先安装 AltStore，再在 AltStore
              里添加下面的源并安装 CKTV。
            </p>
          </div>
          <code className='break-all rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-800 select-all dark:bg-gray-800 dark:text-gray-200'>
            {ALTSTORE_SOURCE}
          </code>
          <a
            href={RELEASES_PAGE}
            className='inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto sm:self-start dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800'
          >
            查看所有版本
          </a>
        </div>
      </div>
    </section>
  );
}
