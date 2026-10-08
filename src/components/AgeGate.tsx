'use client';

import { useState } from 'react';

export const AGE_GATE_KEY = 'cktv-adult-ok';
export const AGE_GATE_CODE = 'cknb';

export function readAgeGate(): boolean {
  try {
    return sessionStorage.getItem(AGE_GATE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AgeNotice() {
  return (
    <p className='mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400'>
      免责声明：仅限年满 18 周岁。进入口令
      cknb。片源来自第三方，本站不存储、不制作。
    </p>
  );
}

export default function AgeGate({
  title,
  onUnlock,
}: {
  title: string;
  onUnlock: () => void;
}) {
  const [code, setCode] = useState('');
  const [wrong, setWrong] = useState(false);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (code.trim().toLowerCase() === AGE_GATE_CODE) {
      sessionStorage.setItem(AGE_GATE_KEY, '1');
      onUnlock();
      return;
    }
    setWrong(true);
  };

  return (
    <div className='fixed inset-0 z-[1800] flex items-center justify-center bg-black/70 px-4'>
      <form
        onSubmit={submit}
        className='w-full max-w-md overflow-hidden border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950'
      >
        <div className='h-1 bg-green-600' />
        <div className='px-5 pb-5 pt-4'>
          <h1 className='text-base font-semibold text-gray-900 dark:text-gray-100'>
            {title}
          </h1>
          <div className='mt-3 space-y-2 text-sm leading-6 text-gray-600 dark:text-gray-300'>
            <p>
              免责声明：本栏目只给年满 18
              周岁的访客。片源来自第三方，本站不存储、不制作这些视频。
            </p>
            <p>未满 18 周岁请直接离开。进入后产生的浏览后果由你自己承担。</p>
            <p>
              进入口令：
              <span className='font-semibold text-gray-900 dark:text-gray-100'>
                cknb
              </span>
            </p>
          </div>
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
          {wrong ? <p className='mt-2 text-sm text-red-600'>口令不对</p> : null}
          <button
            type='submit'
            className='mt-4 w-full bg-green-600 py-2.5 text-sm font-medium text-white hover:bg-green-700'
          >
            进入
          </button>
        </div>
      </form>
    </div>
  );
}
