#!/usr/bin/env node
/* eslint-disable no-console, @typescript-eslint/no-var-requires */

// next-on-pages 生成的 _routes.json 只把 /_next/static/* 排除在 Functions 之外，
// public 里的图标、清单、Service Worker 每次请求都要启动一次函数：多一次冷启动，还算进函数请求数。
// 这里把 public 下的文件和目录也排除掉，让 Pages 直接当静态文件发。
// 原来由 next.config.js 的 headers() 给图标加的缓存头，静态文件拿不到，改写进 _headers。

const fs = require('fs');
const path = require('path');

// Pages 规定 include 和 exclude 加起来最多 100 条
const MAX_RULES = 100;

const HEADERS_START = '# === START ck-tv static headers ===';
const HEADERS_END = '# === END ck-tv static headers ===';

// 和 next.config.js 里 headers() 的值保持一致
const STATIC_HEADERS = [
  ['/logo.png', 'public, max-age=86400'],
  ['/favicon.ico', 'public, max-age=86400'],
  ['/icons/*', 'public, max-age=86400'],
  // Service Worker 每次都要重新确认，新版本才能及时生效
  ['/sw.js', 'no-cache'],
];

// public 里每个文件一条精确规则，每个目录一条通配规则
function publicRules(entries) {
  return entries
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) =>
      entry.isDirectory() ? `/${entry.name}/*` : `/${entry.name}`
    )
    .sort();
}

function mergeRoutes(routes, rules) {
  const include = Array.isArray(routes.include) ? routes.include : ['/*'];
  const exclude = Array.isArray(routes.exclude) ? [...routes.exclude] : [];
  for (const rule of rules) {
    if (include.length + exclude.length >= MAX_RULES) break;
    if (!exclude.includes(rule)) exclude.push(rule);
  }
  return { ...routes, include, exclude };
}

function mergeHeaders(existing) {
  const start = existing.indexOf(HEADERS_START);
  const end = existing.indexOf(HEADERS_END);
  const base =
    start >= 0 && end > start
      ? existing.slice(0, start) + existing.slice(end + HEADERS_END.length)
      : existing;
  const block = [
    HEADERS_START,
    ...STATIC_HEADERS.flatMap(([route, value]) => [
      route,
      `  cache-control: ${value}`,
    ]),
    HEADERS_END,
  ].join('\n');
  return `${base.trimEnd()}\n${block}\n`;
}

function main() {
  const root = path.join(__dirname, '..');
  const output = path.join(root, '.vercel', 'output', 'static');
  const routesFile = path.join(output, '_routes.json');
  if (!fs.existsSync(routesFile)) {
    console.error(`找不到 ${routesFile}，先运行 next-on-pages`);
    process.exit(1);
  }

  const entries = fs.readdirSync(path.join(root, 'public'), {
    withFileTypes: true,
  });
  const routes = mergeRoutes(
    JSON.parse(fs.readFileSync(routesFile, 'utf8')),
    publicRules(entries)
  );
  fs.writeFileSync(routesFile, `${JSON.stringify(routes, null, 2)}\n`);

  const headersFile = path.join(output, '_headers');
  const existing = fs.existsSync(headersFile)
    ? fs.readFileSync(headersFile, 'utf8')
    : '';
  fs.writeFileSync(headersFile, mergeHeaders(existing));

  console.log(
    `静态文件不再经过 Functions：${routes.exclude.length} 条排除规则`
  );
}

if (require.main === module) {
  main();
}

module.exports = { mergeHeaders, mergeRoutes, publicRules, MAX_RULES };
