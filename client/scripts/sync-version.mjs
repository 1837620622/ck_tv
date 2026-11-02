#!/usr/bin/env node
/* eslint-disable no-console -- 命令行工具，结果输出到终端 */
// 客户端版本号只在一处定义：以 package.json 为准，同步到 tauri.conf.json、Cargo.toml 和 Cargo.lock。
// README.md 里「版本信息」那一段也由这里生成（夹在 version:start 和 version:end 两个标记之间），不用手改。
//
//   node scripts/sync-version.mjs                       以 package.json 的版本为准，同步所有文件
//   node scripts/sync-version.mjs 1.2.1                 设成新版本，并同步所有文件和 README
//   node scripts/sync-version.mjs 1.2.1 --after app-v1.2.0
//                                                       新版本必须比已发布的 app-v1.2.0 大，否则不写入
//   node scripts/sync-version.mjs --check               只检查是否一致（CI 使用），README 也检查
//   node scripts/sync-version.mjs --check --tag app-v1.2.1 --after app-v1.2.0
//                                                       另外检查发布标签和版本一致，并且版本比上一个发布大
//
// 为什么要比较：应用内更新只会安装比当前版本大的版本。版本号倒退或停在原地，老用户就收不到更新。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 版本比较和应用判断「有没有更新」用的是同一份代码，脚本和应用不会对不上
import {
  compareVersions as compareAppVersions,
  parseVersion as parseAppVersion,
} from '../src/js/lib/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  packageJson: join(root, 'package.json'),
  tauriConf: join(root, 'src-tauri', 'tauri.conf.json'),
  cargoToml: join(root, 'src-tauri', 'Cargo.toml'),
  cargoLock: join(root, 'src-tauri', 'Cargo.lock'),
  readme: join(root, 'README.md'),
};
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const TAG = /^app-v(.+)$/;
const README_START = '<!-- version:start -->';
const README_END = '<!-- version:end -->';

const readText = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(readText(path));

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/**
 * 比较两个版本号，返回 1、0 或 -1。规则和应用里判断更新用的一样（见 src/js/lib/version.js）：
 * 预发布里的数字按数值比较，所以 beta.11 比 beta.2 大。
 */
export function compareVersions(a, b) {
  const left = parseAppVersion(a);
  const right = parseAppVersion(b);
  if (!left) throw new Error(`版本号格式不对：${a}`);
  if (!right) throw new Error(`版本号格式不对：${b}`);
  return compareAppVersions(left, right);
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
  if (!parseAppVersion(previous))
    return `上一个发布的版本号格式不对：${previous}`;
  if (compareVersions(version, previous) > 0) return null;
  return `版本 ${version} 没有比已发布的 ${previous} 大。已安装的应用只会更新到更大的版本号，请把版本号调大。`;
}

/**
 * README 里「版本信息」那一段，只由版本号决定。
 * 其中的 --after 就是下一次升版本要填的标签，也就是当前版本的标签。
 */
export function versionBlock(version) {
  // 每段之间都空一行，和 prettier 的格式一致，所以 README 格式化后内容不变
  return [
    README_START,
    '',
    '<!-- 由 scripts/sync-version.mjs 生成，不要手改 -->',
    '',
    `当前版本：**${version}**，标签 \`app-v${version}\`。`,
    '',
    '下一次升版本，在 `client` 目录运行（新版本号必须比它大）：',
    '',
    '```bash',
    `node scripts/sync-version.mjs <新版本号> --after app-v${version}`,
    '```',
    '',
    README_END,
  ].join('\n');
}

/** 把 README 里的版本信息换成当前版本的内容。标记缺少或重复时报错，不改任何内容。 */
export function replaceVersionBlock(text, version) {
  const start = text.indexOf(README_START);
  const end = text.indexOf(README_END);
  const valid =
    start !== -1 &&
    end > start &&
    text.indexOf(README_START, start + 1) === -1 &&
    text.indexOf(README_END, end + 1) === -1;
  if (!valid) {
    throw new Error(
      `README 里要有且只有一对标记：${README_START} 和 ${README_END}`
    );
  }
  return (
    text.slice(0, start) +
    versionBlock(version) +
    text.slice(end + README_END.length)
  );
}

/** README 的版本信息是不是当前版本：一致返回 null，否则返回一句中文说明 */
export function readmeProblem(text, version) {
  let expected;
  try {
    expected = replaceVersionBlock(text, version);
  } catch (error) {
    return error.message;
  }
  return expected === text
    ? null
    : `README 里的版本信息和版本号 ${version} 不一致，运行 node scripts/sync-version.mjs 更新`;
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
    const readmeIssue = readmeProblem(readText(files.readme), version);
    if (readmeIssue) fail(readmeIssue);
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
      `✓ 版本一致：${version}，README 已同步${tag ? `，标签 ${tag} 匹配` : ''}${
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
  // 先算好 README 的新内容：标记不对就什么文件都不写
  let readme;
  try {
    readme = replaceVersionBlock(readText(files.readme), target);
  } catch (error) {
    fail(error.message);
  }
  writeVersion(target);
  writeFileSync(files.readme, readme);
  console.log(`✓ 版本已同步为 ${target}，README 的版本信息已更新`);
}

// 被测试导入时不执行命令行逻辑
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2));
}
