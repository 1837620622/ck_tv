import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  newerThanReleaseProblem,
  versionOfTag,
} from '../scripts/sync-version.mjs';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'sync-version.mjs'
);

test('版本号按数字比较，不按字符串比较', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.1.0', '2.0.0'), -1);
  assert.equal(compareVersions('0.9.12', '0.10.0'), -1);
});

test('预发布版本比同号的正式版本小', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0-beta.1'), 1);
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0-beta.2', '1.2.0-beta.1'), 1);
});

test('标签和版本号都能识别，空值没有版本', () => {
  assert.equal(versionOfTag('app-v1.1.0'), '1.1.0');
  assert.equal(versionOfTag('1.1.0'), '1.1.0');
  assert.equal(versionOfTag('  '), null);
  assert.equal(versionOfTag(undefined), null);
});

test('新版本必须比已发布的最新版本大', () => {
  assert.equal(newerThanReleaseProblem('1.2.0', 'app-v1.1.0'), null);
  assert.equal(newerThanReleaseProblem('1.1.1', 'app-v1.1.0'), null);
  assert.match(newerThanReleaseProblem('1.1.0', 'app-v1.1.0'), /1\.1\.0 大/);
  assert.match(newerThanReleaseProblem('1.0.9', 'app-v1.1.0'), /1\.1\.0/);
});

test('第一次发布没有已发布版本，不做比较', () => {
  assert.equal(newerThanReleaseProblem('1.0.0', ''), null);
  assert.equal(newerThanReleaseProblem('1.0.0', null), null);
});

test('命令行：版本比已发布的大时通过，否则失败', () => {
  const pass = spawnSync(
    process.execPath,
    [script, '--check', '--after', 'app-v0.0.1'],
    {
      encoding: 'utf8',
    }
  );
  assert.equal(pass.status, 0, pass.stderr);
  const fail = spawnSync(
    process.execPath,
    [script, '--check', '--after', 'app-v99.0.0'],
    {
      encoding: 'utf8',
    }
  );
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /没有比已发布的 99\.0\.0 大/);
});

test('命令行：--after 后面缺少值时直接报错', () => {
  const result = spawnSync(process.execPath, [script, '--check', '--after'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--after 后面需要一个值/);
});
