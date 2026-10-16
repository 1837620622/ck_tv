'use client';

import { useEffect, useState } from 'react';

let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;

// 入口显不显示只听 /api/gate。失败或地区不符都当国内，不把栏目画出来。
function loadForeign(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (!pending) {
    pending = fetch('/api/gate', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { foreign?: boolean }) => {
        cached = data.foreign === true;
        return cached;
      })
      .catch(() => {
        cached = false;
        return false;
      });
  }
  return pending;
}

export function useForeignColumns(): boolean {
  const [foreign, setForeign] = useState(false);
  useEffect(() => {
    let gone = false;
    loadForeign().then((value) => {
      if (!gone) setForeign(value);
    });
    return () => {
      gone = true;
    };
  }, []);
  return foreign;
}

export function isRestrictedColumn(href: string): boolean {
  return href === '/adult' || href === '/huangguo';
}
