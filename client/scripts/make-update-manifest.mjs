#!/usr/bin/env node
/* eslint-disable no-console -- 命令行工具，结果输出到终端 */
// 生成发布清单，和安装包一起上传到 Release：
//   update.json    应用内「检查更新」读取的清单（见 src-tauri/src/update.rs）
//   altstore.json  iOS 的 AltStore 源：用户在 AltStore 里添加后可以安装和更新
//   cktv-icon.png  AltStore 显示的图标
//   release-notes.md  Release 页面的说明：标签注释、下载表格和 SHA-256 校验值
//
//   node scripts/make-update-manifest.mjs \
//     --version <版本号> \
//     --tag app-v<版本号> \
//     --repo 1837620622/ck_tv \
//     --assets-dir downloads \
//     --icon src-tauri/icons/icon.png \
//     --out-dir out \
//     [--notes-file notes.md] \
//     [--mirror-base https://tv.chuankangkk.top/cktv/app-v<版本号>]
//
// 五个平台的安装包必须都在 --assets-dir 里，缺一个就失败，不发出不完整的版本。
// 所有地址都必须是 https，域名在白名单里（和 src-tauri/src/update.rs 保持一致）。

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_NAME = 'cktv-icon.png';
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
// 与 src/styles/tokens.css 里的 --brand-500 一致
const TINT_COLOR = '#22c55e';

const OPTIONS = [
  'version',
  'tag',
  'repo',
  'assets-dir',
  'icon',
  'out-dir',
  'notes-file',
  'mirror-base',
];
const REQUIRED = ['version', 'tag', 'repo', 'assets-dir', 'icon', 'out-dir'];

// 与 src-tauri/src/update.rs 里的 ALLOWED_LINK_HOSTS 保持一致
export const ALLOWED_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'tv.chuankangkk.top',
  'ck-tv.pages.dev',
];

// 五个平台。key 与应用里的 platform_name() 一致；test 根据文件名判断是哪个平台的安装包。
export const PLATFORMS = [
  {
    key: 'macos',
    label: 'macOS（通用版）',
    test: (name) => name.endsWith('.dmg'),
  },
  {
    key: 'windows',
    label: 'Windows 安装程序',
    test: (name) => name.endsWith('-setup.exe'),
  },
  {
    key: 'linux',
    label: 'Linux（AppImage）',
    test: (name) => name.endsWith('.AppImage'),
  },
  { key: 'android', label: '安卓 APK', test: (name) => name.endsWith('.apk') },
  {
    key: 'ios',
    label: 'iPhone / iPad（IPA）',
    test: (name) => name.endsWith('.ipa'),
  },
];

/** 只允许 https 且在白名单里的地址，返回规范化后的地址 */
export function checkLink(label, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label}地址格式不对：${raw}`);
  }
  if (url.protocol !== 'https:')
    throw new Error(`${label}必须是 https 地址：${raw}`);
  const allowed = ALLOWED_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`)
  );
  if (!allowed) throw new Error(`${label}的域名不在白名单里：${url.hostname}`);
  return url.toString();
}

/** 在文件名列表里找出某个平台的安装包：必须恰好一个 */
export function findInstaller(names, platform) {
  const matches = names.filter((name) => platform.test(name));
  if (matches.length === 0) throw new Error(`缺少${platform.label}的安装包`);
  if (matches.length > 1) {
    throw new Error(`${platform.label}的安装包不止一个：${matches.join('、')}`);
  }
  return matches[0];
}

/**
 * 生成 update.json 和 altstore.json 的内容。纯函数：不读写文件，方便测试。
 * installers 的键是平台名，每个值是 { name, size, sha256 }。
 */
export function buildManifests({
  version,
  tag,
  repo,
  notes,
  pubDate,
  bundle,
  installers,
  mirrorBase = null,
  iconName = ICON_NAME,
}) {
  const releaseBase = `https://github.com/${repo}/releases/download/${tag}`;
  const sourceUrl = `https://github.com/${repo}/releases/latest/download/altstore.json`;
  const mirrorPrefix = mirrorBase
    ? checkLink('国内线路', mirrorBase).replace(/\/+$/, '')
    : null;

  const platforms = {};
  for (const platform of PLATFORMS) {
    const item = installers[platform.key];
    if (!item) throw new Error(`缺少${platform.label}的安装包信息`);
    const file = encodeURIComponent(item.name);
    const entry = {
      label: platform.label,
      url: checkLink(`${platform.label}下载`, `${releaseBase}/${file}`),
    };
    if (mirrorPrefix) {
      entry.mirror = checkLink(
        `${platform.label}国内线路`,
        `${mirrorPrefix}/${file}`
      );
    }
    entry.sha256 = item.sha256;
    entry.size = item.size;
    if (platform.key === 'ios') {
      entry.source = checkLink('AltStore 源', sourceUrl);
    }
    platforms[platform.key] = entry;
  }

  const update = {
    version,
    pubDate,
    notes: notes || null,
    releaseUrl: checkLink(
      '发布页',
      `https://github.com/${repo}/releases/tag/${tag}`
    ),
    platforms,
  };

  const ios = installers.ios;
  const iosUrl = platforms.ios.url;
  const altstore = {
    name: bundle.productName,
    identifier: `${bundle.identifier}.source`,
    sourceURL: sourceUrl,
    apps: [
      {
        name: bundle.productName,
        bundleIdentifier: bundle.identifier,
        developerName: bundle.productName,
        version,
        versionDate: pubDate,
        downloadURL: iosUrl,
        localizedDescription: bundle.longDescription,
        iconURL: checkLink('图标', `${releaseBase}/${iconName}`),
        tintColor: TINT_COLOR,
        category: 'entertainment',
        size: ios.size,
        versions: [
          {
            version,
            date: pubDate,
            localizedDescription: notes || `版本 ${version}`,
            downloadURL: iosUrl,
            size: ios.size,
            minOSVersion: bundle.iosMinimumSystemVersion,
          },
        ],
      },
    ],
    news: [],
  };
  return { update, altstore };
}

/**
 * 生成 Release 页面的说明（release-notes.md）：标签注释在最前面，然后是每个平台的
 * 文件名、下载地址和国内线路，最后是 SHA-256 校验值（sha256sum -c 可以直接校验）。
 * 纯函数：不读写文件。
 */
export function buildReleaseNotes({ tag, notes, update, installers }) {
  const rows = PLATFORMS.map((platform) => {
    const entry = update.platforms[platform.key];
    const file = installers[platform.key].name;
    const mirror = entry.mirror ? `[国内线路](${entry.mirror})` : '—';
    return `| ${platform.label} | \`${file}\` | [下载](${entry.url}) | ${mirror} |`;
  });
  const checksums = PLATFORMS.map((platform) => {
    const item = installers[platform.key];
    return `${item.sha256}  ${item.name}`;
  });
  return [
    notes || `CKTV 客户端 ${tag}`,
    '',
    '## 下载',
    '',
    '| 平台 | 安装包 | 下载 | 国内线路 |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `iPhone / iPad 的安装包没有签名，需要用 AltStore 或 SideStore 安装。在 AltStore 里添加这个源：${update.platforms.ios.source}`,
    '',
    '## 校验值（SHA-256）',
    '',
    '```text',
    ...checksums,
    '```',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--')) throw new Error(`看不懂参数：${key}`);
    const name = key.slice(2);
    if (!OPTIONS.includes(name)) throw new Error(`不认识的参数：${key}`);
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${key} 缺少值`);
    }
    options[name] = value;
  }
  return options;
}

function readBundleInfo() {
  const config = JSON.parse(
    readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')
  );
  return {
    productName: config.productName,
    identifier: config.identifier,
    longDescription: config.bundle?.longDescription ?? '',
    iosMinimumSystemVersion: config.bundle?.iOS?.minimumSystemVersion ?? '14.0',
  };
}

function checkIcon(path) {
  const head = readFileSync(path).subarray(0, PNG_SIGNATURE.length);
  if (!head.equals(PNG_SIGNATURE))
    throw new Error(`图标必须是 PNG 文件：${path}`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main(argv) {
  const options = parseArgs(argv);
  for (const key of REQUIRED) {
    if (!options[key]) throw new Error(`缺少参数 --${key}`);
  }
  const { version, tag, repo } = options;
  if (!SEMVER.test(version)) throw new Error(`版本号格式不对：${version}`);
  if (tag !== `app-v${version}`) {
    throw new Error(
      `标签 ${tag} 和版本 ${version} 不一致，标签应为 app-v${version}`
    );
  }
  if (!REPO.test(repo)) throw new Error(`仓库格式应为 owner/name：${repo}`);

  const assetsDir = options['assets-dir'];
  const names = readdirSync(assetsDir).filter((name) =>
    statSync(join(assetsDir, name)).isFile()
  );
  const installers = {};
  for (const platform of PLATFORMS) {
    const name = findInstaller(names, platform);
    const path = join(assetsDir, name);
    installers[platform.key] = {
      name,
      size: statSync(path).size,
      sha256: sha256File(path),
    };
  }

  checkIcon(options.icon);
  const notes = options['notes-file']
    ? readFileSync(options['notes-file'], 'utf8').trim()
    : '';
  const { update, altstore } = buildManifests({
    version,
    tag,
    repo,
    notes,
    // 只要日期，应用里显示「发布于 2026-11-02」
    pubDate: new Date().toISOString().slice(0, 10),
    bundle: readBundleInfo(),
    installers,
    mirrorBase: options['mirror-base'] ?? null,
  });

  const outDir = options['out-dir'];
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'update.json'),
    `${JSON.stringify(update, null, 2)}\n`
  );
  writeFileSync(
    join(outDir, 'altstore.json'),
    `${JSON.stringify(altstore, null, 2)}\n`
  );
  copyFileSync(options.icon, join(outDir, ICON_NAME));
  writeFileSync(
    join(outDir, 'release-notes.md'),
    buildReleaseNotes({ tag, notes, update, installers })
  );

  const mirror = options['mirror-base'] ? '，含国内线路' : '，没有国内线路';
  console.log(
    `✓ 已生成 ${outDir}：update.json、altstore.json、${ICON_NAME}、release-notes.md（版本 ${version}${mirror}）`
  );
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
