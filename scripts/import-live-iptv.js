#!/usr/bin/env node
/* eslint-disable */
/**
 * 从 iptv-org 的中国区清单导入直播候选源，生成 src/lib/live-iptv.ts。
 * 只保留 https 地址：站点是 https，浏览器会拦截 http 的混合内容。
 * 用法：node scripts/import-live-iptv.js
 * 导入后的地址还要经过 /api/live/health 检查（清单可达、允许跨域），不通过的默认隐藏。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const SOURCE =
  'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/cn.m3u';
const OUT = path.join(__dirname, '..', 'src', 'lib', 'live-iptv.ts');

function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          return resolve(
            download(
              new URL(res.headers.location, url).toString(),
              redirects - 1
            )
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

function groupOf(name) {
  if (/CCTV|CGTN/i.test(name)) return 'cctv';
  if (/新闻|news/i.test(name)) return 'news';
  return 'local';
}

function cleanName(raw) {
  return raw
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(
      /\s*\((?:\d{3,4}[ip]|\d{3,4}i|2160p|1080p|720p|576p|540p|480p|576i)\)\s*/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(text) {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

(async () => {
  const text = await download(SOURCE);
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF')) continue;
    const name = cleanName(lines[i].split(',').slice(1).join(',').trim());
    const url = (lines[i + 1] || '').trim();
    if (!name || !url.startsWith('https://')) continue;
    if (/\[Geo-blocked\]/i.test(lines[i])) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    channels.push({
      id: `iptv-${slug(name)}`,
      name,
      group: groupOf(name),
      url,
    });
  }

  const body = `// 由 scripts/import-live-iptv.js 生成，请勿手改。来源：${SOURCE}
// 地址只保留 https。是否真能播由 /api/live/health 在部署环境里检查。
export const LIVE_IPTV_CANDIDATES = ${JSON.stringify(
    channels,
    null,
    2
  )} as const;
`;
  fs.writeFileSync(OUT, body, 'utf8');
  console.log(
    `wrote ${channels.length} candidates to ${path.relative(
      process.cwd(),
      OUT
    )}`
  );
})().catch((error) => {
  console.error('导入失败:', error.message);
  process.exit(1);
});
