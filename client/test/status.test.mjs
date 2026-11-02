import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeUpdate } from '../src/js/lib/status.js';

const download = {
  label: '安卓 APK',
  url: 'https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/CKTV_1.1.0_android.apk',
  mirrorUrl: null,
  sha256: 'abc',
  size: 10,
  sourceUrl: null,
};

test('describeUpdate 对空状态给出空闲提示', () => {
  const view = describeUpdate(null);
  assert.equal(view.tone, 'idle');
  assert.equal(view.action, null);
});

test('describeUpdate 检查中和已是最新', () => {
  assert.equal(describeUpdate({ status: 'checking' }).tone, 'busy');
  const latest = describeUpdate({
    status: 'upToDate',
    currentVersion: 'v1.0.0',
  });
  assert.equal(latest.tone, 'ok');
  assert.match(latest.subtitle, /v1\.0\.0/);
  assert.equal(latest.subtitle.includes('vv'), false);
  assert.equal(latest.action, null);
});

test('有新版本且有安装包时，给出下载按钮', () => {
  const update = {
    status: 'available',
    latestVersion: '1.1.0',
    currentVersion: '1.0.0',
    skipped: false,
    platform: 'android',
    download,
  };
  const view = describeUpdate(update);
  assert.equal(view.action, 'download');
  assert.match(view.title, /v1\.1\.0/);
  assert.equal(view.title.includes('vv'), false);
});

test('iOS 有新版本时走 AltStore，不直接给 IPA 按钮', () => {
  const view = describeUpdate({
    status: 'available',
    latestVersion: '1.1.0',
    currentVersion: '1.0.0',
    platform: 'ios',
    download: { ...download, sourceUrl: 'https://github.com/x/altstore.json' },
  });
  assert.equal(view.action, 'altstore');
});

test('跳过的版本仍然可以下载，但说明已经跳过', () => {
  const view = describeUpdate({
    status: 'available',
    latestVersion: '1.1.0',
    currentVersion: '1.0.0',
    platform: 'windows',
    skipped: true,
    download,
  });
  assert.equal(view.action, 'download');
  assert.equal(view.subtitle, '你已跳过这个版本，需要时仍可以下载');
});

test('清单里没有本机平台的安装包时，只能去发布页', () => {
  const withRelease = describeUpdate({
    status: 'available',
    latestVersion: '1.1.0',
    platform: 'windows',
    download: null,
    releaseUrl: 'https://github.com/1837620622/ck_tv/releases/tag/app-v1.1.0',
  });
  assert.equal(withRelease.tone, 'warn');
  assert.equal(withRelease.action, 'release');

  const withoutRelease = describeUpdate({
    status: 'available',
    latestVersion: '1.1.0',
    platform: 'windows',
    download: null,
    releaseUrl: null,
  });
  assert.equal(withoutRelease.action, null);
});

test('出错时显示原因，没有原因时给出通用提示', () => {
  const withReason = describeUpdate({ status: 'error', error: '网络不通' });
  assert.equal(withReason.tone, 'danger');
  assert.equal(withReason.subtitle, '网络不通');
  assert.equal(describeUpdate({ status: 'error' }).subtitle, '请稍后再试');
});
