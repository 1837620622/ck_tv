import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
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
  expectedPixels,
  IOS_ICON_SLOTS,
  iosContentsJson,
  patchAndroid,
  patchIos,
  pngSize,
} from '../scripts/patch-mobile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_ICONS = join(ROOT, 'src-tauri/icons/android');
const IOS_ICONS = join(ROOT, 'src-tauri/icons/ios');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'cktv-patch-'));
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 模拟 tauri android init 生成的工程里和补丁有关的几个文件 */
function fakeAndroidProject() {
  const gen = join(tempDir(), 'android');
  const main = join(gen, 'app/src/main');
  write(
    join(main, 'java/top/chuankangkk/cktv/MainActivity.kt'),
    'package top.chuankangkk.cktv\n\nclass MainActivity : TauriActivity()\n'
  );
  const theme =
    '<resources>\n  <style name="Theme.cktv_app" parent="Theme.Material3.DayNight.NoActionBar" />\n</resources>\n';
  write(join(main, 'res/values/themes.xml'), theme);
  write(join(main, 'res/values-night/themes.xml'), theme);
  write(join(main, 'res/mipmap-xxxhdpi/ic_launcher.png'), 'tauri-default');
  return gen;
}

test('安卓：图标换成网站标志，三层自适应图标（背景、标志、单色）', () => {
  const gen = fakeAndroidProject();
  patchAndroid({ genDir: gen, iconsDir: ANDROID_ICONS });
  const res = join(gen, 'app/src/main/res');
  assert.deepEqual(
    readFileSync(join(res, 'mipmap-xxxhdpi/ic_launcher.png')),
    readFileSync(join(ANDROID_ICONS, 'mipmap-xxxhdpi/ic_launcher.png'))
  );
  for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const xml = readFileSync(join(res, 'mipmap-anydpi-v26', name), 'utf8');
    assert.match(xml, /@mipmap\/ic_launcher_background/);
    assert.match(xml, /@mipmap\/ic_launcher_foreground/);
    assert.match(xml, /@mipmap\/ic_launcher_monochrome/);
  }
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const layer of ['background', 'foreground', 'monochrome']) {
      assert.ok(
        existsSync(join(res, `mipmap-${density}/ic_launcher_${layer}.png`)),
        `${density} ${layer}`
      );
    }
  }
  rmSync(dirname(gen), { recursive: true, force: true });
});

test('安卓：自适应图标每层是 108dp，旧式图标是 48dp', () => {
  const scales = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [density, scale] of Object.entries(scales)) {
    const dir = join(ANDROID_ICONS, `mipmap-${density}`);
    assert.equal(
      pngSize(join(dir, 'ic_launcher_foreground.png')).width,
      108 * scale
    );
    assert.equal(
      pngSize(join(dir, 'ic_launcher_background.png')).width,
      108 * scale
    );
    assert.equal(pngSize(join(dir, 'ic_launcher.png')).width, 48 * scale);
  }
});

test('安卓：MainActivity 保留包名，处理状态栏、导航栏和输入法', () => {
  const gen = fakeAndroidProject();
  patchAndroid({ genDir: gen, iconsDir: ANDROID_ICONS });
  const source = readFileSync(
    join(gen, 'app/src/main/java/top/chuankangkk/cktv/MainActivity.kt'),
    'utf8'
  );
  assert.match(source, /^package top\.chuankangkk\.cktv$/m);
  assert.match(source, /class MainActivity : TauriActivity\(\)/);
  assert.match(source, /SystemBarStyle\.dark/);
  assert.match(source, /WindowInsetsCompat\.Type\.systemBars\(\)/);
  assert.match(source, /WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(source, /WindowInsetsCompat\.Type\.ime\(\)/);
  rmSync(dirname(gen), { recursive: true, force: true });
});

test('安卓：主题改成深色，沿用原来的主题名，底色和启动页一致', () => {
  const gen = fakeAndroidProject();
  patchAndroid({ genDir: gen, iconsDir: ANDROID_ICONS });
  const res = join(gen, 'app/src/main/res');
  for (const path of ['values/themes.xml', 'values-night/themes.xml']) {
    const theme = readFileSync(join(res, path), 'utf8');
    assert.match(
      theme,
      /<style name="Theme\.cktv_app" parent="Theme\.Material3\.Dark\.NoActionBar">/
    );
    assert.match(theme, /@color\/cktv_background/);
  }
  assert.match(
    readFileSync(join(res, 'values/cktv_colors.xml'), 'utf8'),
    /#FF060A13/
  );
  rmSync(dirname(gen), { recursive: true, force: true });
});

test('安卓：工程不完整时直接失败，不打出带默认图标的包', () => {
  const gen = join(tempDir(), 'android');
  assert.throws(
    () => patchAndroid({ genDir: gen, iconsDir: ANDROID_ICONS }),
    /没有找到安卓工程/
  );
  const project = fakeAndroidProject();
  rmSync(
    join(project, 'app/src/main/java/top/chuankangkk/cktv/MainActivity.kt')
  );
  assert.throws(
    () => patchAndroid({ genDir: project, iconsDir: ANDROID_ICONS }),
    /没有找到 MainActivity\.kt/
  );
});

/** 模拟 tauri ios init 生成的 AppIcon.appiconset（带模板自己的图标） */
function fakeIosProject() {
  const gen = join(tempDir(), 'apple');
  const set = join(gen, 'Assets.xcassets/AppIcon.appiconset');
  write(join(set, 'Contents.json'), '{"images":[]}');
  write(join(set, 'AppIcon-60x60@3x.png'), 'tauri-default');
  write(join(set, 'Old-Template-Icon.png'), 'tauri-default');
  return { gen, set };
}

test('iOS：每一格都放 CKTV 图标，Contents.json 一一对应，模板的旧图标删掉', () => {
  const { gen, set } = fakeIosProject();
  patchIos({ genDir: gen, iconsDir: IOS_ICONS });
  for (const [, , , filename] of IOS_ICON_SLOTS) {
    assert.deepEqual(
      readFileSync(join(set, filename)),
      readFileSync(join(IOS_ICONS, filename)),
      filename
    );
  }
  assert.equal(existsSync(join(set, 'Old-Template-Icon.png')), false);
  const contents = JSON.parse(readFileSync(join(set, 'Contents.json'), 'utf8'));
  assert.equal(contents.images.length, IOS_ICON_SLOTS.length);
  assert.ok(
    contents.images.some(
      (image) => image.idiom === 'ios-marketing' && image.size === '1024x1024'
    )
  );
  rmSync(dirname(gen), { recursive: true, force: true });
});

test('iOS：仓库里的图标尺寸和每一格要求的一致', () => {
  for (const [, size, scale, filename] of IOS_ICON_SLOTS) {
    const want = expectedPixels(size, scale);
    const { width, height } = pngSize(join(IOS_ICONS, filename));
    assert.equal(width, want, filename);
    assert.equal(height, want, filename);
  }
  assert.equal(expectedPixels('83.5x83.5', '2x'), 167);
  assert.equal(JSON.parse(iosContentsJson()).info.version, 1);
});

test('iOS：缺图标或尺寸不对时失败，不改动工程', () => {
  const { gen, set } = fakeIosProject();
  const icons = join(tempDir(), 'ios');
  cpSync(IOS_ICONS, icons, { recursive: true });
  // 用一张 1024 的图冒充 20x20@1x
  cpSync(
    join(icons, 'AppIcon-512@2x.png'),
    join(icons, 'AppIcon-20x20@1x.png')
  );
  assert.throws(() => patchIos({ genDir: gen, iconsDir: icons }), /应为 20×20/);
  assert.equal(
    readFileSync(join(set, 'Contents.json'), 'utf8'),
    '{"images":[]}'
  );
  rmSync(join(icons, 'AppIcon-20x20@1x.png'));
  assert.throws(
    () => patchIos({ genDir: gen, iconsDir: icons }),
    /缺少 iOS 图标/
  );
});
