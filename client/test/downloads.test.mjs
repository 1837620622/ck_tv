import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canPlay,
  checkSource,
  displayTitle,
  folderOf,
  formatBytes,
  hostOf,
  isRunning,
  kindLabel,
  prefillFrom,
  progressPercent,
  progressText,
  rewritePlaylist,
  STAGE_CONVERTING,
  STATUS_CANCELED,
  STATUS_DONE,
  STATUS_FAILED,
  STATUS_RUNNING,
  statusLabel,
  statusTone,
  summarize,
  upsertItem,
} from '../src/js/lib/downloads.js';

// 和原生层 downloads.rs 发出的记录结构一致（字段名是 camelCase）
const item = (overrides = {}) => ({
  id: 'a1',
  title: '电影',
  source: 'https://cdn.example.com/movie.mp4',
  kind: 'file',
  entry: 'a1.mp4',
  status: STATUS_RUNNING,
  done: 0,
  total: 0,
  error: null,
  createdMs: 1,
  path: '/data/downloads/a1.mp4',
  ...overrides,
});

test('formatBytes 按大小选择单位，非法值显示 0 B', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(18.4 * 1024 * 1024), '18.4 MB');
  assert.equal(formatBytes(2.1 * 1024 ** 3), '2.1 GB');
  assert.equal(formatBytes(1024 ** 5 * 3), '3072 TB');
});

test('进度百分比：完成后固定 100，总量未知时返回 null', () => {
  assert.equal(progressPercent(item({ status: STATUS_DONE })), 100);
  assert.equal(progressPercent(item({ done: 500, total: 0 })), null);
  assert.equal(progressPercent(item({ done: 1, total: 3 })), 33);
  assert.equal(progressPercent(item({ done: 9, total: 4 })), 100);
});

test('进度文字：分片按个数，文件按大小，未知时显示准备中', () => {
  const hls = { kind: 'hls' };
  assert.equal(progressText({ ...hls, done: 2, total: 5 }), '2 / 5 个分片');
  assert.equal(progressText({ ...hls, done: 0, total: 0 }), '准备中…');
  assert.equal(
    progressText(item({ done: 1024 * 1024, total: 2 * 1024 * 1024 })),
    '1.0 MB / 2.0 MB'
  );
  assert.equal(progressText(item({ done: 0, total: 0 })), '准备中…');
  assert.equal(progressText(item({ done: 2048, total: 0 })), '2.0 KB');
});

test('状态文字和颜色与组件样式对应', () => {
  assert.equal(statusLabel(STATUS_RUNNING), '下载中');
  assert.equal(statusLabel(STATUS_DONE), '已完成');
  assert.equal(statusLabel(STATUS_FAILED), '失败');
  assert.equal(statusLabel(STATUS_CANCELED), '已取消');
  assert.equal(statusLabel('weird'), '未知');
  assert.equal(statusTone(STATUS_RUNNING), 'pill-info');
  assert.equal(statusTone(STATUS_DONE), 'pill-ok');
  assert.equal(statusTone(STATUS_FAILED), 'pill-danger');
  assert.equal(statusTone(STATUS_CANCELED), '');
});

test('种类文字：分片视频和视频文件', () => {
  assert.equal(kindLabel('hls'), '分片视频（HLS）');
  assert.equal(kindLabel('file'), '视频文件');
});

test('只有下载完成且有入口文件的项目才能播放', () => {
  assert.equal(canPlay(item({ status: STATUS_DONE })), true);
  assert.equal(canPlay(item({ status: STATUS_RUNNING })), false);
  assert.equal(canPlay(item({ status: STATUS_FAILED })), false);
  assert.equal(canPlay(item({ status: STATUS_DONE, path: '' })), false);
  assert.equal(isRunning(item({ status: STATUS_RUNNING })), true);
  assert.equal(isRunning(item({ status: STATUS_DONE })), false);
});

test('域名取自地址，带端口时保留端口，非法地址返回空', () => {
  assert.equal(hostOf('https://cdn.example.com/a/b.m3u8'), 'cdn.example.com');
  assert.equal(
    hostOf('http://media.example.com:8080/x.mp4'),
    'media.example.com:8080'
  );
  assert.equal(hostOf('不是地址'), '');
});

test('显示名称：优先用户填写的名称，其次域名，最后是占位文字', () => {
  assert.equal(displayTitle(item({ title: '  第一集  ' })), '第一集');
  assert.equal(
    displayTitle(item({ title: '', source: 'https://cdn.example.com/x.mp4' })),
    'cdn.example.com'
  );
  assert.equal(displayTitle(item({ title: '', source: '' })), '未命名视频');
});

test('地址检查：去掉空白，只接受 http 和 https', () => {
  assert.deepEqual(checkSource('  https://cdn.example.com/a.m3u8 \n'), {
    url: 'https://cdn.example.com/a.m3u8',
  });
  assert.deepEqual(checkSource('http://cdn.example.com/a.mp4'), {
    url: 'http://cdn.example.com/a.mp4',
  });
  assert.equal(checkSource('').error, '请先粘贴视频地址');
  assert.equal(checkSource('   ').error, '请先粘贴视频地址');
  assert.equal(checkSource(null).error, '请先粘贴视频地址');
  assert.match(checkSource('不是地址').error, /https:\/\//);
  for (const bad of [
    'ftp://x.example.com/a.mp4',
    'file:///etc/hosts',
    'javascript:alert(1)',
  ]) {
    assert.equal(checkSource(bad).error, '只能下载 http 或 https 的地址', bad);
  }
});

test('地址过长时直接拒绝，避免把整段文字交给原生层', () => {
  const long = `https://cdn.example.com/${'a'.repeat(9000)}.mp4`;
  assert.match(checkSource(long).error, /太长/);
});

test('概况文字：空列表、全部完成、有进行中的项目', () => {
  assert.equal(summarize([]), '还没有下载的视频');
  assert.equal(summarize([item({ status: STATUS_DONE })]), '共 1 项');
  assert.equal(
    summarize([item({ id: 'b' }), item({ id: 'c', status: STATUS_DONE })]),
    '共 2 项 · 进行中 1 项'
  );
});

test('文件夹路径保留原来的分隔符，没有文件夹时返回空', () => {
  assert.equal(
    folderOf('/data/downloads/a1/index.m3u8'),
    '/data/downloads/a1/'
  );
  assert.equal(
    folderOf('C:\\Users\\me\\AppData\\downloads\\a1\\index.m3u8'),
    'C:\\Users\\me\\AppData\\downloads\\a1\\'
  );
  assert.equal(folderOf('index.m3u8'), '');
});

test('本地播放列表：分片文件名换成完整地址，标签原样保留', () => {
  const local = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXTINF:4.000,',
    '00000.ts',
    '#EXTINF:3.500,',
    '00001.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const rewritten = rewritePlaylist(local, (name) => `asset://x/${name}`);
  assert.equal(
    rewritten,
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXTINF:4.000,',
      'asset://x/00000.ts',
      '#EXTINF:3.500,',
      'asset://x/00001.ts',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n')
  );
});

test('更新列表：新记录放在最前，已有记录原地替换，原数组不变', () => {
  const first = item({ id: 'first' });
  const second = item({ id: 'second' });
  const list = [second, first];

  const added = upsertItem(list, item({ id: 'third' }));
  assert.deepEqual(
    added.map((row) => row.id),
    ['third', 'second', 'first']
  );

  const replaced = upsertItem(list, item({ id: 'first', done: 9 }));
  assert.deepEqual(
    replaced.map((row) => row.id),
    ['second', 'first']
  );
  assert.equal(replaced[1].done, 9);

  assert.deepEqual(
    list.map((row) => row.id),
    ['second', 'first']
  );
  assert.equal(list[1].done, 0);
});

test('prefillFrom 读出站点发来的地址和名称，没有地址时返回 null', () => {
  assert.equal(prefillFrom(''), null);
  assert.equal(prefillFrom('?title=只有名称'), null);
  assert.equal(prefillFrom('?url='), null);

  const url = 'https://cdn.example.com/show/index.m3u8';
  const search = `?url=${encodeURIComponent(url)}&title=${encodeURIComponent(
    '第一集'
  )}`;
  assert.deepEqual(prefillFrom(search), { url, title: '第一集' });

  // 没有名称时是空字符串；名称最多 80 个字
  assert.deepEqual(prefillFrom(`?url=${encodeURIComponent(url)}`), {
    url,
    title: '',
  });
  assert.equal(
    prefillFrom(`?url=x&title=${'字'.repeat(100)}`).title.length,
    80
  );
});

test('分片下载完正在合成 MP4：显示合成中，进度条不确定', () => {
  const converting = {
    kind: 'hls',
    status: STATUS_RUNNING,
    stage: STAGE_CONVERTING,
    done: 40,
    total: 40,
  };
  assert.equal(progressText(converting), '正在合成 MP4…');
  assert.equal(progressPercent(converting), null);
  // 合成好以后原生层把这一项改成普通视频文件，按大小显示
  const converted = {
    kind: 'file',
    status: STATUS_DONE,
    done: 3 * 1024 * 1024,
    total: 3 * 1024 * 1024,
  };
  assert.equal(progressText(converted), '3.0 MB / 3.0 MB');
  assert.equal(kindLabel('file'), '视频文件');
});
