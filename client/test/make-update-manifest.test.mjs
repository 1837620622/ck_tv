import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildManifests,
  buildReleaseNotes,
  checkLink,
  findInstaller,
  PLATFORMS,
} from '../scripts/make-update-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'scripts', 'make-update-manifest.mjs');
const REPO = '1837620622/ck_tv';
const TAG = 'app-v1.1.0';
const BUNDLE = {
  productName: 'CKTV',
  identifier: 'top.chuankangkk.cktv',
  longDescription: 'CKTV 传康播放器的原生客户端。',
  iosMinimumSystemVersion: '14.0',
};
const FILES = {
  macos: 'CKTV_1.1.0_universal.dmg',
  windows: 'CKTV_1.1.0_x64-setup.exe',
  linux: 'CKTV_1.1.0_amd64.AppImage',
  android: 'CKTV_1.1.0_android.apk',
  ios: 'CKTV_1.1.0_ios-unsigned.ipa',
};

function installersFor(files = FILES) {
  const installers = {};
  for (const platform of PLATFORMS) {
    installers[platform.key] = {
      name: files[platform.key],
      size: 1000,
      sha256: 'a'.repeat(64),
    };
  }
  return installers;
}

function manifests(overrides = {}) {
  return buildManifests({
    version: '1.1.0',
    tag: TAG,
    repo: REPO,
    notes: '- 修复全屏拖动进度',
    pubDate: '2026-11-02',
    bundle: BUNDLE,
    installers: installersFor(),
    ...overrides,
  });
}

test('only the hosts the app trusts are accepted', () => {
  assert.equal(
    checkLink(
      'x',
      'https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/a.dmg'
    ),
    'https://github.com/1837620622/ck_tv/releases/download/app-v1.1.0/a.dmg'
  );
  assert.ok(checkLink('x', 'https://objects.githubusercontent.com/asset'));
  assert.ok(checkLink('x', 'https://tv.chuankangkk.top/cktv/a.apk'));
  assert.throws(() => checkLink('x', 'http://github.com/asset'), /https/);
  assert.throws(
    () => checkLink('x', 'https://apps.apple.com/app/id1'),
    /白名单/
  );
  assert.throws(
    () => checkLink('x', 'https://github.com.evil.example/a.apk'),
    /白名单/
  );
  assert.throws(() => checkLink('x', 'https://gitee.com/cktv/a.apk'), /白名单/);
  assert.throws(() => checkLink('x', 'not a url'), /格式不对/);
});

test('each platform matches exactly one installer file', () => {
  const names = [
    'CKTV_1.1.0_amd64.deb',
    'CKTV_1.1.0_amd64.AppImage',
    'CKTV_1.1.0_universal.dmg',
    'CKTV_1.1.0_x64-setup.exe',
    'CKTV_1.1.0_x64_en-US.msi',
    'CKTV_1.1.0_android.apk',
    'CKTV_1.1.0_ios-unsigned.ipa',
  ];
  const byKey = Object.fromEntries(
    PLATFORMS.map((p) => [p.key, findInstaller(names, p)])
  );
  assert.deepEqual(byKey, FILES);
  const linux = PLATFORMS.find((p) => p.key === 'linux');
  assert.throws(
    () => findInstaller(['a.AppImage', 'b.AppImage'], linux),
    /不止一个/
  );
  assert.throws(() => findInstaller([], linux), /缺少/);
});

test('update.json has the shape the app reads', () => {
  const { update } = manifests();
  assert.deepEqual(Object.keys(update).sort(), [
    'notes',
    'platforms',
    'pubDate',
    'releaseUrl',
    'version',
  ]);
  assert.equal(update.version, '1.1.0');
  assert.equal(update.pubDate, '2026-11-02');
  assert.equal(
    update.releaseUrl,
    `https://github.com/${REPO}/releases/tag/${TAG}`
  );
  assert.deepEqual(Object.keys(update.platforms).sort(), [
    'android',
    'ios',
    'linux',
    'macos',
    'windows',
  ]);
  const android = update.platforms.android;
  assert.equal(android.label, '安卓 APK');
  assert.equal(
    android.url,
    `https://github.com/${REPO}/releases/download/${TAG}/${FILES.android}`
  );
  assert.equal(android.sha256, 'a'.repeat(64));
  assert.equal(android.size, 1000);
  assert.equal(android.mirror, undefined, '没有给国内线路时不写 mirror');
  assert.equal(
    update.platforms.ios.source,
    `https://github.com/${REPO}/releases/latest/download/altstore.json`
  );
});

test('a mirror base adds one mirror link per platform', () => {
  const { update } = manifests({
    mirrorBase: 'https://tv.chuankangkk.top/cktv/app-v1.1.0/',
  });
  assert.equal(
    update.platforms.android.mirror,
    'https://tv.chuankangkk.top/cktv/app-v1.1.0/CKTV_1.1.0_android.apk'
  );
  assert.deepEqual(update.platforms.android.mirrors, [
    'https://tv.chuankangkk.top/cktv/app-v1.1.0/CKTV_1.1.0_android.apk',
  ]);
  for (const platform of PLATFORMS) {
    assert.ok(
      update.platforms[platform.key].mirror,
      `${platform.key} 缺少国内线路`
    );
    assert.deepEqual(
      update.platforms[platform.key].mirrors,
      [update.platforms[platform.key].mirror]
    );
  }
});

test('a mirror on a host the app does not trust is refused', () => {
  assert.throws(
    () => manifests({ mirrorBase: 'https://gitee.com/cktv/app-v1.1.0' }),
    /白名单/
  );
});

test('altstore.json points at the iOS IPA and the stable source URL', () => {
  const { altstore } = manifests();
  assert.equal(
    altstore.sourceURL,
    `https://github.com/${REPO}/releases/latest/download/altstore.json`
  );
  const [app] = altstore.apps;
  assert.equal(app.bundleIdentifier, 'top.chuankangkk.cktv');
  assert.equal(app.version, '1.1.0');
  assert.equal(
    app.downloadURL,
    `https://github.com/${REPO}/releases/download/${TAG}/${FILES.ios}`
  );
  assert.equal(
    app.iconURL,
    `https://github.com/${REPO}/releases/download/${TAG}/cktv-icon.png`
  );
  assert.equal(app.versions[0].minOSVersion, '14.0');
  assert.equal(app.versions[0].localizedDescription, '- 修复全屏拖动进度');
});

test('release-notes.md lists every platform with its links and checksum', () => {
  const installers = installersFor();
  const { update } = manifests({
    mirrorBase: 'https://tv.chuankangkk.top/cktv/app-v1.1.0',
  });
  const text = buildReleaseNotes({
    tag: TAG,
    notes: '- 修复全屏拖动进度',
    update,
    installers,
  });
  assert.ok(text.startsWith('- 修复全屏拖动进度\n'), '标签注释放在最前面');
  for (const platform of PLATFORMS) {
    const entry = update.platforms[platform.key];
    const row = `| ${platform.label} | \`${FILES[platform.key]}\` | [下载](${
      entry.url
    }) | [国内线路](${entry.mirror}) |`;
    assert.ok(text.includes(row), `${platform.key} 缺少下载行`);
    assert.ok(
      text.includes(`${'a'.repeat(64)}  ${FILES[platform.key]}\n`),
      `${platform.key} 缺少校验值`
    );
  }
  assert.ok(text.includes(update.platforms.ios.source), '缺少 AltStore 源地址');
});

test('release-notes.md without a mirror shows a dash and a fallback title', () => {
  const { update } = manifests();
  const text = buildReleaseNotes({
    tag: TAG,
    notes: '',
    update,
    installers: installersFor(),
  });
  assert.ok(text.startsWith(`CKTV 客户端 ${TAG}\n`), '没有说明时用标签名');
  assert.ok(
    text.includes(
      `| 安卓 APK | \`${FILES.android}\` | [下载](${update.platforms.android.url}) | — |`
    )
  );
});

test('the command line writes both manifests, the icon and matching checksums', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cktv-manifest-'));
  try {
    const assets = join(dir, 'downloads');
    mkdirSync(assets);
    for (const name of Object.values(FILES)) {
      writeFileSync(join(assets, name), `payload:${name}`);
    }
    const icon = join(dir, 'icon.png');
    writeFileSync(
      icon,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
    );
    writeFileSync(join(dir, 'notes.md'), '- 修复若干问题\n');
    const out = join(dir, 'out');

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--version',
        '1.1.0',
        '--tag',
        TAG,
        '--repo',
        REPO,
        '--assets-dir',
        assets,
        '--icon',
        icon,
        '--out-dir',
        out,
        '--notes-file',
        join(dir, 'notes.md'),
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);

    const update = JSON.parse(readFileSync(join(out, 'update.json'), 'utf8'));
    const android = update.platforms.android;
    const expected = createHash('sha256')
      .update(`payload:${FILES.android}`)
      .digest('hex');
    assert.equal(android.sha256, expected);
    assert.equal(update.notes, '- 修复若干问题');
    JSON.parse(readFileSync(join(out, 'altstore.json'), 'utf8'));
    assert.equal(readFileSync(join(out, 'cktv-icon.png')).length, 10);
    const releaseNotes = readFileSync(join(out, 'release-notes.md'), 'utf8');
    assert.ok(releaseNotes.startsWith('- 修复若干问题\n'));
    assert.ok(releaseNotes.includes(`[下载](${update.platforms.android.url})`));
    assert.ok(releaseNotes.includes(`${expected}  ${FILES.android}\n`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line refuses a tag that does not match the version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cktv-manifest-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--version',
        '1.1.0',
        '--tag',
        'app-v1.0.0',
        '--repo',
        REPO,
        '--assets-dir',
        dir,
        '--icon',
        dir,
        '--out-dir',
        dir,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /不一致/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
