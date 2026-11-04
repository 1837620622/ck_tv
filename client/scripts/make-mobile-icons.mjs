#!/usr/bin/env node
/* eslint-disable no-console -- 命令行工具，结果输出到终端 */
// 从网站标志生成手机图标（和 public/icon.svg、public/logo.png 是同一张图，不另外设计）：
//
//   NODE_PATH=$(npm root -g) node scripts/make-mobile-icons.mjs
//
// 需要能 import 'playwright'（用它把 SVG 渲染成 PNG）。生成的文件提交进仓库，构建时不需要 Playwright。
//
//   iOS      整块方形铺满、不透明（圆角由系统加），assets/mobile-icons/ios-fullbleed.svg
//   安卓     自适应图标三层：深色渐变背景、标志（圆环 + 播放键 + 小点）、单色层（安卓 13 主题图标）。
//            画布 108dp，系统只露出中间 72dp：网站标志的 512 单位正好映射到这 72dp，
//            所以不管手机把图标裁成圆形、圆角方形还是水滴形，看到的都和网站标志一样。
//            旧系统用的 ic_launcher.png 就是网站标志本身，ic_launcher_round.png 是圆形裁切。

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedPixels,IOS_ICON_SLOTS } from './patch-mobile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'assets/mobile-icons');
const SITE_ICON = join(ROOT, '..', 'public/icon.svg');
const ANDROID = join(ROOT, 'src-tauri/icons/android');
const IOS = join(ROOT, 'src-tauri/icons/ios');

// 安卓各密度：自适应图标层 108dp，旧式图标 48dp
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

const ADAPTIVE_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/make-mobile-icons.mjs 生成：和网站标志相同的三层自适应图标 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@mipmap/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;

const read = (name) => readFileSync(join(SOURCES, name), 'utf8');

/** 圆形图标：铺满的方形标志裁成圆 */
function roundSvg() {
  const inner = read('ios-fullbleed.svg')
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs><clipPath id="round"><circle cx="256" cy="256" r="256"/></clipPath></defs><g clip-path="url(#round)">${inner}</g></svg>`;
}

async function main() {
  // 用 require 加载：它会读 NODE_PATH，全局安装的 Playwright 也能找到
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  async function render(svg, size, file, { opaque = false } = {}) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:${
        opaque ? '#060908' : 'transparent'
      }">` +
        svg.replace(
          '<svg ',
          `<svg style="display:block;width:${size}px;height:${size}px" `
        ) +
        '</body></html>'
    );
    mkdirSync(dirname(file), { recursive: true });
    await page.screenshot({
      path: file,
      omitBackground: !opaque,
      clip: { x: 0, y: 0, width: size, height: size },
    });
  }

  // iOS：每一格一张，尺寸由 patch-mobile.mjs 的表格决定
  const iosSvg = read('ios-fullbleed.svg');
  for (const [, size, scale, filename] of IOS_ICON_SLOTS) {
    await render(iosSvg, expectedPixels(size, scale), join(IOS, filename), {
      opaque: true,
    });
  }

  // 安卓
  const layers = {
    ic_launcher_background: read('android-background.svg'),
    ic_launcher_foreground: read('android-foreground.svg'),
    ic_launcher_monochrome: read('android-monochrome.svg'),
  };
  const siteIcon = readFileSync(SITE_ICON, 'utf8');
  const round = roundSvg();
  for (const [density, scale] of DENSITIES) {
    const dir = join(ANDROID, `mipmap-${density}`);
    for (const [name, svg] of Object.entries(layers)) {
      await render(svg, Math.round(108 * scale), join(dir, `${name}.png`));
    }
    await render(
      siteIcon,
      Math.round(48 * scale),
      join(dir, 'ic_launcher.png')
    );
    await render(
      round,
      Math.round(48 * scale),
      join(dir, 'ic_launcher_round.png')
    );
  }
  const anydpi = join(ANDROID, 'mipmap-anydpi-v26');
  mkdirSync(anydpi, { recursive: true });
  writeFileSync(join(anydpi, 'ic_launcher.xml'), ADAPTIVE_XML);
  writeFileSync(join(anydpi, 'ic_launcher_round.xml'), ADAPTIVE_XML);
  // 背景改成图片层后，不再需要单色背景
  rmSync(join(ANDROID, 'values'), { recursive: true, force: true });

  await browser.close();
  console.log('✓ 手机图标已从网站标志重新生成');
}

main().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
