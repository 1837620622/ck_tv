import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interval, percent, relativeTime } from '../src/js/lib/format.js';

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('relativeTime 处理从未检查和刚刚', () => {
  assert.equal(relativeTime(null), '从未');
  assert.equal(relativeTime(NOW - 30_000, NOW), '刚刚');
  assert.equal(relativeTime(NOW + 10_000, NOW), '刚刚');
});

test('relativeTime 显示分钟、小时和昨天', () => {
  assert.equal(relativeTime(NOW - 5 * MIN, NOW), '5 分钟前');
  assert.equal(relativeTime(NOW - 3 * HOUR, NOW), '3 小时前');
  assert.equal(relativeTime(NOW - 30 * HOUR, NOW), '昨天');
});

test('relativeTime 更早的时间显示日期', () => {
  assert.match(relativeTime(NOW - 6 * DAY, NOW), /^\d{4}-\d{2}-\d{2}$/);
});

test('percent 限制在 0 到 100 之间', () => {
  assert.equal(percent(42.4), '42%');
  assert.equal(percent(120), '100%');
  assert.equal(percent(-5), '0%');
  assert.equal(percent(null), '');
});

test('interval 显示检查频率', () => {
  assert.equal(interval(6), '每 6 小时');
  assert.equal(interval(24), '每天');
  assert.equal(interval(168), '每周');
});
