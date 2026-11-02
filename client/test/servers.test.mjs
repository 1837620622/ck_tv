import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hostOf,
  latencyLabel,
  latencyTone,
  normalizeServerInput,
  pickBestServer,
} from '../src/js/lib/servers.js';

test('normalizeServerInput 补上 https 并只保留站点地址', () => {
  assert.equal(
    normalizeServerInput('tv.chuankangkk.top'),
    'https://tv.chuankangkk.top'
  );
  assert.equal(
    normalizeServerInput('  https://ck-tv.pages.dev/some/path?x=1 '),
    'https://ck-tv.pages.dev'
  );
  assert.equal(
    normalizeServerInput('https://example.com:8443/'),
    'https://example.com:8443'
  );
});

test('normalizeServerInput 拒绝不安全或不完整的地址', () => {
  assert.throws(() => normalizeServerInput(''), /请输入线路地址/);
  assert.throws(() => normalizeServerInput('http://example.com'), /https/);
  assert.throws(
    () => normalizeServerInput('https://user:pass@example.com'),
    /账号/
  );
  assert.throws(() => normalizeServerInput('https://'), /格式不对/);
});

test('hostOf 只显示域名和端口', () => {
  assert.equal(hostOf('https://tv.chuankangkk.top/play'), 'tv.chuankangkk.top');
  assert.equal(hostOf('not a url'), 'not a url');
});

test('pickBestServer 选延迟最低的可用线路', () => {
  const probes = [
    { url: 'https://a.example', ok: true, latencyMs: 300 },
    { url: 'https://b.example', ok: true, latencyMs: 120 },
    { url: 'https://c.example', ok: false, latencyMs: null },
  ];
  assert.equal(pickBestServer(probes, null), 'https://b.example');
});

test('pickBestServer 优先使用可用的首选线路', () => {
  const probes = [
    { url: 'https://a.example', ok: true, latencyMs: 300 },
    { url: 'https://b.example', ok: true, latencyMs: 120 },
  ];
  assert.equal(
    pickBestServer(probes, 'https://a.example'),
    'https://a.example'
  );
});

test('pickBestServer 首选不可用时退回到最快的线路', () => {
  const probes = [
    { url: 'https://a.example', ok: false, latencyMs: null },
    { url: 'https://b.example', ok: true, latencyMs: 120 },
  ];
  assert.equal(
    pickBestServer(probes, 'https://a.example'),
    'https://b.example'
  );
});

test('pickBestServer 全部不可用或没有结果时返回 null', () => {
  assert.equal(
    pickBestServer([{ url: 'https://a.example', ok: false }], null),
    null
  );
  assert.equal(pickBestServer([], null), null);
  assert.equal(pickBestServer(undefined, null), null);
});

test('latencyTone 和 latencyLabel 给出颜色等级和文字', () => {
  assert.equal(latencyTone({ ok: true, latencyMs: 120 }), 'ok');
  assert.equal(latencyTone({ ok: true, latencyMs: 500 }), 'warn');
  assert.equal(latencyTone({ ok: false }), 'danger');
  assert.equal(latencyTone(null), 'danger');
  assert.equal(latencyLabel(null), '未测速');
  assert.equal(latencyLabel({ ok: false, error: '连接超时' }), '连接超时');
  assert.equal(latencyLabel({ ok: true, latencyMs: 88 }), '88 ms');
});
