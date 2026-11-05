import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  downloadAction,
  downloadLines,
  mirrorUrlList,
  LINE_GITHUB,
  LINE_MIRROR,
} from '../src/js/lib/download.js';

const download = {
  label: '安卓 APK',
  url: 'https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_android.apk',
  mirrorUrl: 'https://mirror.example.org/CKTV_1.1.0_android.apk',
  mirrors: [
    'https://mirror.example.org/CKTV_1.1.0_android.apk',
    'https://gh-proxy.com/https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_android.apk',
  ],
  sha256: null,
  size: null,
  sourceUrl: null,
};

const update = (overrides) => ({
  status: 'available',
  platform: 'android',
  region: 'unknown',
  download,
  ...overrides,
});

test('海外用户直接打开，不弹窗', () => {
  assert.equal(downloadAction(update({ region: 'other' })), 'direct');
});

test('中国大陆和无法判断地区的用户，先弹窗选线路', () => {
  assert.equal(downloadAction(update({ region: 'cn' })), 'choose');
  assert.equal(downloadAction(update({ region: 'unknown' })), 'choose');
});

test('iOS 总是弹窗，因为要先在 AltStore 里添加源', () => {
  assert.equal(
    downloadAction(update({ platform: 'ios', region: 'other' })),
    'choose'
  );
});

test('没有安装包时没有任何下载动作', () => {
  assert.equal(downloadAction(update({ download: null })), 'none');
  assert.deepEqual(downloadLines(update({ download: null })), {
    lines: [],
    recommended: null,
  });
});

test('中国大陆用户推荐国内线路，并排在前面；多条国内线路都列出', () => {
  const { lines, recommended } = downloadLines(update({ region: 'cn' }));
  assert.equal(recommended, LINE_MIRROR);
  assert.equal(lines[0].key, LINE_MIRROR);
  assert.equal(lines[0].url, download.mirrorUrl);
  assert.equal(lines[1].key, 'mirror-1');
  assert.equal(lines.at(-1).key, LINE_GITHUB);
  assert.equal(lines.length, 3);
});

test('海外用户的推荐和排序都是 GitHub', () => {
  const { lines, recommended } = downloadLines(update({ region: 'other' }));
  assert.equal(recommended, LINE_GITHUB);
  assert.equal(lines[0].key, LINE_GITHUB);
  assert.ok(lines.some((line) => line.key === LINE_MIRROR));
});

test('无法判断地区时两条线路都列出，不推荐', () => {
  const { lines, recommended } = downloadLines(update({ region: 'unknown' }));
  assert.equal(recommended, null);
  assert.equal(lines[0].key, LINE_GITHUB);
});

test('没有配置国内线路时只有 GitHub 一条，不推荐', () => {
  const { lines, recommended } = downloadLines(
    update({
      region: 'cn',
      download: { ...download, mirrorUrl: null, mirrors: [] },
    })
  );
  assert.equal(recommended, null);
  assert.deepEqual(
    lines.map((line) => line.key),
    [LINE_GITHUB]
  );
});

test('mirrorUrlList 合并 mirrorUrl 与 mirrors 并去重', () => {
  assert.deepEqual(mirrorUrlList(download), [
    'https://mirror.example.org/CKTV_1.1.0_android.apk',
    'https://gh-proxy.com/https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_android.apk',
  ]);
  assert.deepEqual(mirrorUrlList({ mirrorUrl: null, mirrors: ['a', 'a', 'b'] }), [
    'a',
    'b',
  ]);
});
