import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  newerThanReleaseProblem,
  readmeProblem,
  replaceVersionBlock,
  versionBlock,
  versionOfTag,
} from '../scripts/sync-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'sync-version.mjs');

function run(args, scriptPath = script) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
  });
}

/**
 * 在临时目录里复制一份版本号相关的文件（脚本、版本比较的代码、版本号文件和 README）。
 * 会改版本号的测试只改这份副本，不碰仓库里的文件。
 */
function sandbox(readme) {
  const dir = mkdtempSync(join(tmpdir(), 'cktv-version-'));
  for (const file of [
    'package.json',
    'README.md',
    'scripts/sync-version.mjs',
    'src/js/lib/version.js',
    'src-tauri/tauri.conf.json',
    'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock',
  ]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  if (readme !== undefined) writeFileSync(join(dir, 'README.md'), readme);
  return dir;
}

test('版本号按数字比较，不按字符串比较', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.0', '2.0.0'), -1);
  assert.equal(compareVersions('0.9.12', '0.10.0'), -1);
});

test('预发布版本比同号的正式版本小，预发布里的数字按数值比较', () => {
  assert.equal(compareVersions('1.2.0', '1.2.0-beta.1'), 1);
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0-beta.2', '1.2.0-beta.1'), 1);
  assert.equal(compareVersions('1.2.0-beta.11', '1.2.0-beta.2'), 1);
});

test('版本号格式不对时报错，不悄悄比较', () => {
  assert.throws(() => compareVersions('1.2', '1.2.0'), /版本号格式不对/);
});

test('标签和版本号都能识别，空值没有版本', () => {
  assert.equal(versionOfTag('app-v1.2.0'), '1.2.0');
  assert.equal(versionOfTag('1.2.0'), '1.2.0');
  assert.equal(versionOfTag('  '), null);
  assert.equal(versionOfTag(undefined), null);
});

test('新版本必须比已发布的最新版本大', () => {
  assert.equal(newerThanReleaseProblem('1.2.1', 'app-v1.2.0'), null);
  assert.equal(newerThanReleaseProblem('1.3.0', 'app-v1.2.0'), null);
  assert.match(newerThanReleaseProblem('1.2.0', 'app-v1.2.0'), /1\.2\.0 大/);
  assert.match(newerThanReleaseProblem('1.1.9', 'app-v1.2.0'), /1\.2\.0/);
  assert.match(newerThanReleaseProblem('1.2.1', 'app-vfoo'), /格式不对/);
});

test('第一次发布没有已发布版本，不做比较', () => {
  assert.equal(newerThanReleaseProblem('1.0.0', ''), null);
  assert.equal(newerThanReleaseProblem('1.0.0', null), null);
});

test('README 的版本信息：替换只改标记之间的内容，内容一致时检查通过', () => {
  const block = versionBlock('1.2.0');
  assert.match(block, /^<!-- version:start -->/);
  assert.match(block, /<!-- version:end -->$/);
  assert.match(block, /当前版本：\*\*1\.2\.0\*\*，标签 `app-v1\.2\.0`/);
  assert.match(
    block,
    /node scripts\/sync-version\.mjs <新版本号> --after app-v1\.2\.0/
  );

  const before = `前言\n\n${versionBlock('1.0.0')}\n\n后记\n`;
  assert.equal(
    replaceVersionBlock(before, '1.2.0'),
    `前言\n\n${block}\n\n后记\n`
  );
  assert.match(readmeProblem(before, '1.2.0'), /不一致/);
  assert.equal(readmeProblem(`前言\n\n${block}\n\n后记\n`, '1.2.0'), null);
});

test('README 标记缺少、重复或顺序反了都报错', () => {
  assert.throws(() => replaceVersionBlock('没有标记', '1.2.0'), /标记/);
  assert.throws(
    () =>
      replaceVersionBlock(
        `${versionBlock('1.2.0')}\n${versionBlock('1.2.0')}`,
        '1.2.0'
      ),
    /标记/
  );
  assert.throws(
    () =>
      replaceVersionBlock(
        '<!-- version:end -->\n<!-- version:start -->',
        '1.2.0'
      ),
    /标记/
  );
  assert.match(readmeProblem('没有标记', '1.2.0'), /标记/);
});

test('仓库里的 README 版本信息和 package.json 一致', () => {
  const { version } = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8')
  );
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.equal(readmeProblem(readme, version), null);
});

test('命令行 --check：版本一致、README 同步，并且比已发布的大时通过', () => {
  const pass = run(['--check', '--after', 'app-v0.0.1']);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /README 已同步/);
});

test('命令行 --check：版本不比已发布的大，或标签和版本不一致时失败', () => {
  const tooOld = run(['--check', '--after', 'app-v99.0.0']);
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.stderr, /没有比已发布的 99\.0\.0 大/);

  const wrongTag = run(['--check', '--tag', 'app-v9.9.9']);
  assert.equal(wrongTag.status, 1);
  assert.match(wrongTag.stderr, /发布标签 app-v9\.9\.9 和版本 \S+ 不一致/);
});

test('命令行：--after 后面缺少值时直接报错', () => {
  const result = run(['--check', '--after']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--after 后面需要一个值/);
});

test('写入新版本：版本号文件和 README 的版本信息一起更新', () => {
  const dir = sandbox();
  const copy = join(dir, 'scripts', 'sync-version.mjs');
  try {
    const bumped = run(['1.3.0'], copy);
    assert.equal(bumped.status, 0, bumped.stderr);
    const read = (file) => readFileSync(join(dir, file), 'utf8');
    assert.equal(JSON.parse(read('package.json')).version, '1.3.0');
    assert.equal(
      JSON.parse(read('src-tauri/tauri.conf.json')).version,
      '1.3.0'
    );
    assert.match(read('src-tauri/Cargo.toml'), /^version = "1\.3\.0"$/m);
    assert.match(
      read('src-tauri/Cargo.lock'),
      /name = "cktv-app"\nversion = "1\.3\.0"/
    );
    assert.match(
      read('README.md'),
      /当前版本：\*\*1\.3\.0\*\*，标签 `app-v1\.3\.0`/
    );
    const check = run(['--check'], copy);
    assert.equal(check.status, 0, check.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README 标记不对时，写入新版本会失败，并且什么文件都不改', () => {
  const dir = sandbox('没有标记的 README\n');
  try {
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const result = run(['1.3.0'], join(dir, 'scripts', 'sync-version.mjs'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /标记/);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README 的版本信息没有跟上版本号时，--check 失败', () => {
  const dir = sandbox(`说明\n\n${versionBlock('1.0.0')}\n`);
  try {
    const result = run(['--check'], join(dir, 'scripts', 'sync-version.mjs'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README 里的版本信息和版本号 \S+ 不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
