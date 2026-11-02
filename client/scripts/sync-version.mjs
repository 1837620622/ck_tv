#!/usr/bin/env node
/* eslint-disable no-console -- 命令行工具，结果输出到终端 */
// 客户端版本号只在一处定义：以 package.json 为准，同步到 tauri.conf.json、Cargo.toml 和 Cargo.lock。
//
//   node scripts/sync-version.mjs                       以 package.json 的版本为准，同步其它文件
//   node scripts/sync-version.mjs 1.2.0                 设成新版本，并同步所有文件
//   node scripts/sync-version.mjs 1.2.0 --after app-v1.1.0
//                                                       新版本必须比已发布的 app-v1.1.0 大，否则不写入
//   node scripts/sync-version.mjs --check               只检查是否一致（CI 使用）
//   node scripts/sync-version.mjs --check --tag app-v1.2.0 --after app-v1.1.0
//                                                       另外检查发布标签和版本一致，并且版本比上一个发布大
//
// 为什么要比较：应用内更新只会安装比当前版本大的版本。版本号倒退或停在原地，老用户就收不到更新。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  packageJson: join(root, 'package.json'),
  tauriConf: join(root, 'src-tauri', 'tauri.conf.json'),
  cargoToml: join(root, 'src-tauri', 'Cargo.toml'),
  cargoLock: join(root, 'src-tauri', 'Cargo.lock'),
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const TAG = /^app-v(.+)$/;

const readText = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(readText(path));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * 比较两个版本号，返回 1、0 或 -1。规则和 semver 一致：
 * 数字部分按数值比较；预发布版本比同号的正式版本小。
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

function parseVersion(text) {
  const match = SEMVER.exec(String(text));
  if (!match) throw new Error(`版本号格式不对：${text}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? '',
  };
}

/** app-v1.1.0 → 1.1.0；已经是版本号的原样返回；空值返回 null */
export function versionOfTag(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = TAG.exec(text);
  return match ? match[1] : text;
}

/**
 * 新版本必须比已经发布的最新版本大。没有已发布版本（第一次发布）时总是通过。
 * 返回 null 表示通过，否则返回一句中文说明。
 */
export function newerThanReleaseProblem(version, after) {
  const previous = versionOfTag(after);
  if (!previous) return null;
  if (compareVersions(version, previous) > 0) return null;
  return `版本 ${version} 没有比已发布的 ${previous} 大。已安装的应用只会更新到更大的版本号，请把版本号调大。`;
}

function currentVersions() {
  return {
    'package.json': readJson(files.packageJson).version,
    'tauri.conf.json': readJson(files.tauriConf).version,
    'Cargo.toml': readText(files.cargoToml).match(
      /\[package\][\s\S]*?^version = "([^"]+)"/m
    )?.[1],
    'Cargo.lock': readText(files.cargoLock).match(
      /name = "cktv-app"\nversion = "([^"]+)"/
    )?.[1],
  };
}

/** 只替换版本那一行，不重新格式化整个文件，diff 保持干净 */
function replaceFirst(path, pattern, version) {
  const text = readText(path);
  if (!pattern.test(text)) fail(`${path} 里找不到版本号`);
  writeFileSync(path, text.replace(pattern, `$1${version}$2`));
}

function writeVersion(version) {
  replaceFirst(files.packageJson, /("version":\s*")[^"]+(")/, version);
  replaceFirst(files.tauriConf, /("version":\s*")[^"]+(")/, version);
  replaceFirst(
    files.cargoToml,
    /(\[package\][\s\S]*?^version = ")[^"]+(")/m,
    version
  );
  replaceFirst(
    files.cargoLock,
    /(name = "cktv-app"\nversion = ")[^"]+(")/,
    version
  );
}

/** 读取 --name 后面的值；没有这个选项返回 null */
function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} 后面需要一个值`);
  return value;
}

/** 去掉选项和它们的值，剩下的就是位置参数（要设置的版本号） */
function positionalArgs(args) {
  const skip = new Set();
  for (const name of ['--tag', '--after']) {
    const index = args.indexOf(name);
    if (index !== -1) {
      skip.add(index);
      skip.add(index + 1);
    }
  }
  return args.filter((arg, index) => !skip.has(index) && !arg.startsWith('--'));
}

function main(args) {
  const check = args.includes('--check');
  const tag = optionValue(args, '--tag');
  const after = optionValue(args, '--after');

  if (check) {
    const versions = currentVersions();
    const unique = [...new Set(Object.values(versions))];
    if (unique.length !== 1 || !unique[0])
      fail(`版本号不一致：${JSON.stringify(versions)}`);
    const [version] = unique;
    if (!SEMVER.test(version)) fail(`版本号格式不对：${version}`);
    if (tag !== null) {
      const match = TAG.exec(String(tag));
      if (!match || match[1] !== version)
        fail(
          `发布标签 ${tag} 和版本 ${version} 不一致，标签应为 app-v${version}`
        );
    }
    const problem =
      after === null ? null : newerThanReleaseProblem(version, after);
    if (problem) fail(problem);
    console.log(
      `✓ 版本一致：${version}${tag ? `，标签 ${tag} 匹配` : ''}${
        after ? `，比已发布的 ${versionOfTag(after) ?? '（无）'} 新` : ''
      }`
    );
    return;
  }

  const [requested] = positionalArgs(args);
  const target = requested ?? readJson(files.packageJson).version;
  if (!SEMVER.test(target)) fail(`版本号必须是 x.y.z 格式：${target}`);
  const problem =
    after === null ? null : newerThanReleaseProblem(target, after);
  if (problem) fail(problem);
  writeVersion(target);
  console.log(`✓ 版本已同步为 ${target}`);
}

// 被测试导入时不执行命令行逻辑
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
