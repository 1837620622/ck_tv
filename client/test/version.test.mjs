import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareVersions,
  displayVersion,
  isNewer,
  parseVersion,
} from '../src/js/lib/version.js';

test('parseVersion 读取普通版本号和 v 开头的版本号', () => {
  assert.deepEqual(parseVersion('1.2.3'), {
    major: 1,
    minor: 2,
    patch: 3,
    pre: [],
  });
  assert.deepEqual(parseVersion('v10.0.1'), {
    major: 10,
    minor: 0,
    patch: 1,
    pre: [],
  });
});

test('parseVersion 保留预发布标识', () => {
  assert.deepEqual(parseVersion('1.0.0-beta.2'), {
    major: 1,
    minor: 0,
    patch: 0,
    pre: ['beta', '2'],
  });
});

test('parseVersion 忽略构建元数据（+ 后面的部分）', () => {
  assert.deepEqual(parseVersion('1.0.0+build.5'), {
    major: 1,
    minor: 0,
    patch: 0,
    pre: [],
  });
});

test('无法解析的版本号返回 null', () => {
  for (const bad of ['', '1.2', 'abc', 'v', '1.2.3.4', null, undefined]) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

test('compareVersions 先比较主、次、修订号', () => {
  assert.equal(
    compareVersions(parseVersion('1.10.0'), parseVersion('1.9.9')),
    1
  );
  assert.equal(
    compareVersions(parseVersion('2.0.0'), parseVersion('2.0.1')),
    -1
  );
  assert.equal(
    compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3')),
    0
  );
});

test('预发布版本排在正式版之前', () => {
  assert.equal(isNewer('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isNewer('1.0.0-rc.1', '1.0.0'), false);
});

test('预发布里的数字按数值比较', () => {
  assert.equal(isNewer('1.0.0-beta.11', '1.0.0-beta.2'), true);
  assert.equal(isNewer('1.0.0-beta.2', '1.0.0-beta.11'), false);
});

test('数字标识排在字母标识之前，段数多的更大', () => {
  assert.equal(isNewer('1.0.0-alpha', '1.0.0-1'), true);
  assert.equal(isNewer('1.0.0-alpha.1', '1.0.0-alpha'), true);
});

test('isNewer：相同或更旧的版本都不算更新', () => {
  assert.equal(isNewer('1.2.3', '1.2.3'), false);
  assert.equal(isNewer('1.2.2', '1.2.3'), false);
  assert.equal(isNewer('1.2.4', 'v1.2.3'), true);
});

test('isNewer：任一版本无法解析时不提示更新', () => {
  assert.equal(isNewer('latest', '1.0.0'), false);
  assert.equal(isNewer('1.1.0', ''), false);
});

test('displayVersion 统一显示成 v 开头', () => {
  assert.equal(displayVersion('1.2.3'), 'v1.2.3');
  assert.equal(displayVersion('V1.2.3'), 'v1.2.3');
  assert.equal(displayVersion(''), '');
  assert.equal(displayVersion(null), '');
});
