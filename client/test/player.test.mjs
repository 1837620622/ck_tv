import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clamp,
  classifyGesture,
  dimOpacity,
  formatDelta,
  formatTime,
  isPlaylist,
  nextSpeed,
  progressKey,
  readParams,
  resumePoint,
  safeBack,
  seekTarget,
  sourceLabel,
  speedLabel,
  SPEEDS,
  timeAtRatio,
  verticalLevel,
} from '../src/js/lib/player.js';

test('时间格式：不满一小时是 分:秒，满一小时带小时', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(187.9), '03:07');
  assert.equal(formatTime(3727), '1:02:07');
  assert.equal(formatTime(Number.NaN), '00:00');
  assert.equal(formatTime(-3), '00:00');
  assert.equal(formatDelta(15), '+15 秒');
  assert.equal(formatDelta(-65), '-01:05');
});

test('手势：没移动够是点击，横向是调进度，纵向是亮度或音量', () => {
  assert.equal(classifyGesture(3, 4), 'none');
  assert.equal(classifyGesture(40, 10), 'seek');
  assert.equal(classifyGesture(-40, 39), 'seek');
  assert.equal(classifyGesture(5, -60), 'vertical');
});

test('横向拖动：划满宽度最多跳 3 分钟，不超出视频范围', () => {
  assert.equal(seekTarget(600, 400, 400, 3600), 780);
  assert.equal(seekTarget(600, -200, 400, 3600), 510);
  // 短视频：划满宽度就是整段时长
  assert.equal(seekTarget(10, 400, 400, 60), 60);
  assert.equal(seekTarget(10, -400, 400, 60), 0);
  // 时长未知时不动
  assert.equal(seekTarget(42, 100, 400, Number.NaN), 42);
});

test('纵向拖动：向上划变大，结果在 0 到 1 之间', () => {
  assert.equal(verticalLevel(0.5, -100, 200), 1);
  assert.equal(verticalLevel(0.5, 50, 200), 0.25);
  assert.equal(verticalLevel(0.2, 400, 200), 0);
  assert.equal(dimOpacity(1), 0);
  assert.equal(dimOpacity(0), 0.75);
  assert.equal(dimOpacity(0.6), 0.3);
});

test('进度条位置换算和续播判断', () => {
  assert.equal(timeAtRatio(0.25, 400), 100);
  assert.equal(timeAtRatio(2, 400), 400);
  assert.equal(timeAtRatio(0.5, 0), 0);
  assert.equal(resumePoint(5, 3600), 0);
  assert.equal(resumePoint(1200, 3600), 1200);
  assert.equal(resumePoint(3590, 3600), 0);
  assert.equal(resumePoint(Number.NaN, 3600), 0);
  assert.equal(clamp(5, 0, 3), 3);
});

test('进度记录的键：同一个地址相同，不同地址不同', () => {
  const a = progressKey('https://cdn.example.com/a/index.m3u8');
  assert.equal(a, progressKey('https://cdn.example.com/a/index.m3u8'));
  assert.notEqual(a, progressKey('https://cdn.example.com/b/index.m3u8'));
  assert.match(a, /^cktv-player-pos:[0-9a-z]+$/);
});

test('倍速按钮依次切换，回到 1 倍时显示「倍速」', () => {
  assert.equal(nextSpeed(1), 1.25);
  assert.equal(nextSpeed(SPEEDS.at(-1)), SPEEDS[0]);
  assert.equal(nextSpeed(1.1), 0.5);
  assert.equal(speedLabel(1), '倍速');
  assert.equal(speedLabel(2), '2X');
});

test('地址参数：在线地址只认 http(s)，本机文件和在线地址二选一', () => {
  const online = readParams(
    '?src=https%3A%2F%2Fcdn.example.com%2Fv.m3u8&title=%20第1集%20&back=https%3A%2F%2Ftv.chuankangkk.top%2Fplay'
  );
  assert.equal(online.src, 'https://cdn.example.com/v.m3u8');
  assert.equal(online.file, '');
  assert.equal(online.title, '第1集');
  assert.equal(online.back, 'https://tv.chuankangkk.top/play');
  // javascript: 之类的地址不当成视频地址
  assert.equal(readParams('?src=javascript%3Aalert(1)').src, '');
  const local = readParams('?file=%2Fdata%2Fa.mp4&kind=hls');
  assert.equal(local.file, '/data/a.mp4');
  assert.equal(local.kind, 'hls');
  assert.equal(readParams('?file=x&kind=evil').kind, 'file');
});

test('分片地址判断和来源说明', () => {
  assert.equal(isPlaylist('https://a.example.com/x/index.m3u8?t=1'), true);
  assert.equal(isPlaylist('https://a.example.com/x/video.mp4'), false);
  assert.equal(isPlaylist('blob:abc.m3u8'), true);
  assert.equal(
    sourceLabel({ src: 'https://cdn.example.com/a.mp4', file: '' }),
    'cdn.example.com'
  );
  assert.equal(sourceLabel({ src: '', file: '/x.mp4' }), '本机视频（已下载）');
});

test('返回地址只接受 http(s) 和应用自己的页面', () => {
  assert.equal(safeBack('downloads.html'), 'downloads.html');
  assert.equal(
    safeBack('https://tv.chuankangkk.top/play?id=1'),
    'https://tv.chuankangkk.top/play?id=1'
  );
  assert.equal(safeBack('javascript:alert(1)'), '');
  assert.equal(safeBack(' JavaScript:alert(1)'), '');
  assert.equal(safeBack('data:text/html,<script>1</script>'), '');
  assert.equal(safeBack('../../etc/passwd'), '');
  assert.equal(readParams('?back=javascript%3Aalert(1)').back, '');
});
