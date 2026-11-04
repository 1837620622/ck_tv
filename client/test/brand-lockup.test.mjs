// 启动页（src/index.html + pages.css）和进站画面（src/inject/remote.js）必须画出同一张品牌图、
// 放在同一个位置，从启动页进入站点时画面才不会跳。这里检查两边的图形和位置算式一致。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'src/index.html'), 'utf8');
const css = readFileSync(join(ROOT, 'src/styles/pages.css'), 'utf8');
const remote = readFileSync(join(ROOT, 'src/inject/remote.js'), 'utf8');

/** 只取品牌图那一段 SVG：两边文件里还有别的图标，不能混进来比较 */
function lockupOf(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到品牌图：${startMarker}`);
  return source.slice(start, source.indexOf('</svg>', start));
}
const htmlLockup = lockupOf(html, '<svg\n          class="lockup"');
const remoteLockup = lockupOf(remote, 'const LOCKUP_SVG = `');

/** 取出 <text …>内容</text>，把属性整理成对象，忽略 class 和换行 */
function texts(source) {
  return [...source.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map(
    ([, attrs, content]) => {
      const map = Object.fromEntries(
        [...attrs.matchAll(/([\w-]+)="([^"]*)"/g)]
          .filter(([, key]) => key !== 'class')
          .map(([, key, value]) => [key, value])
      );
      return { ...map, content: content.trim() };
    }
  );
}

/** 标志的路径和圆：两边的数据要一样 */
function shapes(source) {
  return [...source.matchAll(/\b(d|cx|cy|r|rx)="([^"]+)"/g)].map(
    ([, key, value]) => `${key}=${value}`
  );
}

function cssBlock(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `pages.css 里没有 ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const px = (block, property) => {
  const match = block.match(
    new RegExp(`(?:^|\\s)${property}:\\s*([\\d.]+)(px|%)`)
  );
  assert.ok(match, `缺少 ${property}`);
  return Number(match[1]);
};

test('两边是同一张品牌图：画布、网站标志、站名', () => {
  const lockup = /viewBox="0 0 240 180"/;
  assert.match(htmlLockup, lockup);
  assert.match(remoteLockup, lockup);
  const mark = 'transform="translate(68 0) scale(0.203125)"';
  assert.ok(htmlLockup.includes(mark));
  assert.ok(remoteLockup.includes(mark));
  assert.deepEqual(texts(remoteLockup), texts(htmlLockup));
  assert.deepEqual(
    texts(htmlLockup).map((t) => t.content),
    ['CKTV-传康播放器']
  );
  assert.deepEqual(shapes(remoteLockup), shapes(htmlLockup));
});

test('两边的位置算式一致：品牌组中心在 46% 高度，进度条在图下方', () => {
  const center = cssBlock('.boot-center');
  const top = px(center, 'top');
  const svgHeight = px(cssBlock('.lockup'), 'height');
  const progress = cssBlock('.boot-progress');
  const gap = px(progress, 'margin-top');
  const barHeight = px(progress, 'height');
  const barWidth = px(progress, 'width');
  const half = (svgHeight + gap + barHeight) / 2;

  // 背景图：background-position 的百分比按（容器高 - 图高）算，所以偏移是 top% × 图高 - 半个品牌组
  const imageOffset = Number(((top / 100) * svgHeight - half).toFixed(2));
  assert.ok(
    remote.includes(
      `no-repeat 50% calc(${top}% - ${Math.abs(
        imageOffset
      )}px) / 240px ${svgHeight}px`
    ),
    `remote.js 的品牌图位置应为 calc(${top}% - ${Math.abs(imageOffset)}px)`
  );
  // 进度条顶边：中心往下半个品牌组，再减去进度条高度
  const barTop = half - barHeight;
  assert.ok(
    remote.includes(
      `top: calc(${top}% + ${barTop}px); width: ${barWidth}px; height: ${barHeight}px; margin-left: -${
        barWidth / 2
      }px`
    ),
    `remote.js 的进度条位置应为 calc(${top}% + ${barTop}px)、宽 ${barWidth}px`
  );
});

test('进站画面不往页面里加元素，只用可构造样式表', () => {
  const start = remote.indexOf('function entryCurtain()');
  const body = remote.slice(
    start,
    remote.indexOf('/* ---------- 更新提示卡片', start)
  );
  assert.ok(body.includes('adoptedStyleSheets'));
  assert.ok(!body.includes('mountLayer('));
  assert.ok(!body.includes('createElement'));
});
