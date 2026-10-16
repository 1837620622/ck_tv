'use client';

import Link from 'next/link';
import { useState } from 'react';

export function AgeNotice() {
  return (
    <p className='mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400'>
      免责声明：禁止国内访问。中国大陆、香港、台湾不能进入。仅限年满 18
      周岁。本站不制作、不存储、不传播这些影片，只做播放优化。片源在第三方。
    </p>
  );
}

export default function AgeGate({
  title,
  foreign,
  onUnlock,
}: {
  title: string;
  foreign: boolean;
  onUnlock: () => void;
}) {
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!foreign || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch('/api/gate', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json()) as { open?: boolean };
      if (data.open) {
        onUnlock();
        return;
      }
      setWrong(true);
    } catch {
      setWrong(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className='fixed inset-0 z-[1800] flex items-center justify-center bg-black/70 px-4'>
      <form
        onSubmit={submit}
        className='w-full max-w-md overflow-hidden border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950'
      >
        <div className='bg-neutral-950 px-5 py-3 text-sm font-semibold text-white'>
          禁止国内访问
        </div>
        <div className='px-5 pb-5 pt-4'>
          <h1 className='text-base font-semibold text-gray-900 dark:text-gray-100'>
            {title}
          </h1>
          <div className='mt-3 space-y-2 text-sm leading-6 text-gray-600 dark:text-gray-300'>
            <p>中国大陆、香港、台湾的网络不能进入这个栏目。</p>
            <p>
              免责声明：本站不制作、不存储、不传播淫秽内容。这里只是把第三方公开接口接到播放器里，优化站点的浏览和播放。视频在对方服务器，本站不留副本。
            </p>
            <p>
              只给年满 18 周岁、并且人在上述地区以外的访客。未满 18
              周岁请直接离开。你自己进入、自己观看，后果由你承担。
            </p>
            <p>
              权利人认为某个链接不该出现，发邮件到
              2040168455@qq.com，核实后去掉。
            </p>
          </div>
          {foreign ? (
            <>
              <label
                className='mt-4 block text-xs text-gray-500'
                htmlFor='age-code'
              >
                口令
              </label>
              <input
                id='age-code'
                value={code}
                autoFocus
                autoComplete='off'
                onChange={(event) => {
                  setCode(event.target.value);
                  setWrong(false);
                }}
                className='mt-1 h-10 w-full border border-neutral-300 bg-white px-3 text-sm text-gray-900 outline-none focus:border-green-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-gray-100'
              />
              {wrong ? (
                <p className='mt-2 text-sm text-red-600'>口令不对</p>
              ) : null}
              <button
                type='submit'
                disabled={submitting}
                className='mt-4 w-full bg-green-600 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-60'
              >
                {submitting ? '核对中' : '进入'}
              </button>
            </>
          ) : (
            <p className='mt-4 text-sm text-red-600'>当前网络不能进入</p>
          )}
          <Link
            href='/'
            className='mt-2 block w-full border border-neutral-300 py-2.5 text-center text-sm text-gray-700 dark:border-neutral-700 dark:text-gray-200'
          >
            返回首页
          </Link>
        </div>
      </form>
    </div>
  );
}
