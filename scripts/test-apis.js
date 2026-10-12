#!/usr/bin/env node
/* eslint-disable */
/**
 * ============================================================
 * CKTV 资源站 API 接口批量测试脚本
 * ============================================================
 * 功能：按应用里搜索的方式测试 config.json 中的每个 API 接口
 *   - 请求格式与应用一致：<api>?ac=videolist&wd=<关键字>
 *   - 检查返回的条目里有没有可播放的 m3u8 地址
 *   - 抽一条清单确认是 #EXTM3U（可用 --no-m3u8 关闭）
 *   - 输出可直接粘贴进 config.json 的片段
 *
 * 用法：
 *   node scripts/test-apis.js
 *   node scripts/test-apis.js --keyword=凡人 --timeout=1800 --concurrency=10
 *
 * 候选源：在 config.json 里给条目加 "disabled": true，测试通过后去掉即可启用。
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// 参数
// ------------------------------------------------------------
function argValue(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const CONFIG = {
  keyword: argValue('keyword', '凡人'),
  // 与应用里国内线路的搜索超时保持一致（src/lib/line.ts），超过这个时间用户就等不到了
  timeout: Number(argValue('timeout', 1800)),
  concurrency: Number(argValue('concurrency', 10)),
  retryCount: 1,
  checkManifest: !process.argv.includes('--no-m3u8'),
  manifestTimeout: 5000,
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ------------------------------------------------------------
// 颜色输出
// ------------------------------------------------------------
const colors = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  gray: (text) => `\x1b[90m${text}\x1b[0m`,
};

// ------------------------------------------------------------
// 与应用保持一致的 m3u8 抽取：播放串里任意位置出现的 http(s) .m3u8 地址
// ------------------------------------------------------------
const M3U8_IN_PLAY = /https?:\/\/[^\s$#]+/g;

function firstM3u8(playUrl) {
  const found = String(playUrl || '').match(M3U8_IN_PLAY) || [];
  return found.find((url) => url.includes('.m3u8')) || '';
}

function countPlayableItems(list) {
  return list.filter((item) => firstM3u8(item.vod_play_url)).length;
}

// ------------------------------------------------------------
// 抽一条清单检查是不是合法的 HLS
// ------------------------------------------------------------
async function checkManifest(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.manifestTimeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.apple.mpegurl,*/*',
      },
      redirect: 'follow',
    });
    if (!response.ok)
      return { ok: false, reason: `清单 HTTP ${response.status}` };
    const text = await response.text();
    return text.includes('#EXTM3U')
      ? { ok: true }
      : { ok: false, reason: '返回内容不是 #EXTM3U' };
  } catch (error) {
    return {
      ok: false,
      reason:
        error.name === 'AbortError' ? '清单超时' : `清单错误: ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------
// 测试单个接口（请求格式与应用的搜索一致）
// ------------------------------------------------------------
async function testApi(key, apiUrl, retries = CONFIG.retryCount) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
  const url = apiUrl + '?ac=videolist&wd=' + encodeURIComponent(CONFIG.keyword);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;

    if (!response.ok) {
      return {
        key,
        api: apiUrl,
        status: 'error',
        time: elapsed,
        error: `HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    const list = data && Array.isArray(data.list) ? data.list : [];
    if (list.length === 0) {
      return {
        key,
        api: apiUrl,
        status: 'no-data',
        time: elapsed,
        dataCount: 0,
      };
    }

    const playable = countPlayableItems(list);
    if (playable === 0) {
      return {
        key,
        api: apiUrl,
        status: 'no-m3u8',
        time: elapsed,
        dataCount: list.length,
      };
    }

    let manifest = { ok: true, skipped: true };
    if (CONFIG.checkManifest) {
      const sample = list
        .map((item) => firstM3u8(item.vod_play_url))
        .find(Boolean);
      manifest = await checkManifest(sample);
    }

    return {
      key,
      api: apiUrl,
      status: manifest.ok ? 'playable' : 'manifest-fail',
      time: elapsed,
      dataCount: list.length,
      playableCount: playable,
      error: manifest.ok ? undefined : manifest.reason,
    };
  } catch (error) {
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    if (retries > 0 && error.name !== 'AbortError') {
      return testApi(key, apiUrl, retries - 1);
    }
    return {
      key,
      api: apiUrl,
      status: 'error',
      time: elapsed,
      error:
        error.name === 'AbortError'
          ? `超时（>${CONFIG.timeout}ms）`
          : error.message,
    };
  }
}

// ------------------------------------------------------------
// 并发控制
// ------------------------------------------------------------
async function runWithConcurrency(tasks, concurrency) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const promise = task().then((result) => {
      executing.delete(promise);
      return result;
    });
    results.push(promise);
    executing.add(promise);
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

const LABEL = {
  playable: colors.green('✓ 可播放'),
  'manifest-fail': colors.yellow('⚠ 清单异常'),
  'no-m3u8': colors.yellow('⚠ 无m3u8'),
  'no-data': colors.yellow('⚠ 无数据'),
  error: colors.red('✗ 失败'),
};

// ------------------------------------------------------------
// 主函数
// ------------------------------------------------------------
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log(colors.cyan('  CKTV 资源站 API 接口批量测试'));
  console.log('='.repeat(60) + '\n');

  const configPath = path.join(__dirname, '..', 'config.json');
  if (!fs.existsSync(configPath)) {
    console.error(colors.red('错误: 找不到 config.json 文件'));
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const apiSites = config.api_site;
  const keys = Object.keys(apiSites);

  console.log(`${colors.cyan('接口数量:')} ${keys.length}`);
  console.log(`${colors.cyan('搜索关键字:')} ${CONFIG.keyword}`);
  console.log(
    `${colors.cyan('超时:')} ${CONFIG.timeout}ms（与应用国内线路一致）`
  );
  console.log(
    `${colors.cyan('并发:')} ${CONFIG.concurrency}   ${colors.cyan(
      '清单检查:'
    )} ${CONFIG.checkManifest ? '开' : '关'}`
  );
  console.log('\n' + '-'.repeat(60) + '\n');

  const startTime = Date.now();
  const tasks = keys.map((key) => async () => {
    const site = apiSites[key];
    const result = await testApi(key, site.api);
    const tag = site.disabled ? colors.gray(' [已停用]') : '';
    console.log(
      `  ${LABEL[result.status] || result.status} ${site.name.padEnd(
        12
      )} ${colors.gray(key)} ${colors.gray(result.time + 'ms')}${tag}${
        result.error ? colors.gray(' ' + result.error) : ''
      }`
    );
    return { ...result, name: site.name, disabled: site.disabled === true };
  });

  const results = await runWithConcurrency(tasks, CONFIG.concurrency);
  const totalTime = Date.now() - startTime;

  const count = (status) => results.filter((r) => r.status === status).length;
  const playable = results.filter((r) => r.status === 'playable');

  console.log('\n' + '='.repeat(60));
  console.log(colors.cyan('  测试结果统计'));
  console.log('='.repeat(60) + '\n');
  console.log(`  ${colors.green('✓ 可播放:')}      ${count('playable')}`);
  console.log(`  ${colors.yellow('⚠ 清单异常:')}    ${count('manifest-fail')}`);
  console.log(`  ${colors.yellow('⚠ 无m3u8:')}      ${count('no-m3u8')}`);
  console.log(`  ${colors.yellow('⚠ 无数据:')}      ${count('no-data')}`);
  console.log(`  ${colors.red('✗ 失败:')}          ${count('error')}`);
  console.log(`  ${colors.cyan('总计:')}            ${results.length}`);
  console.log(
    `  ${colors.gray('耗时:')}            ${(totalTime / 1000).toFixed(2)}s`
  );

  if (playable.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(
      colors.green(
        '\n可播放接口（可直接用于 config.json，已停用的请去掉 "disabled"）:\n'
      )
    );
    playable
      .sort((a, b) => a.time - b.time)
      .forEach((r) => {
        const site = apiSites[r.key];
        const entry = {
          name: site.name,
          api: site.api,
          ...(site.detail ? { detail: site.detail } : {}),
          ...(site.region ? { region: site.region } : {}),
        };
        console.log(
          `  "${r.key}": ${JSON.stringify(entry)},  ${colors.gray(
            `${r.time}ms, 可播 ${r.playableCount} 条`
          )}`
        );
      });
  }

  const report = {
    testTime: new Date().toISOString(),
    keyword: CONFIG.keyword,
    timeoutMs: CONFIG.timeout,
    manifestChecked: CONFIG.checkManifest,
    totalApis: results.length,
    playableCount: playable.length,
    totalTimeMs: totalTime,
    results: results.map((r) => ({
      key: r.key,
      name: r.name,
      api: r.api,
      disabled: r.disabled,
      status: r.status,
      timeMs: r.time,
      dataCount: r.dataCount,
      playableCount: r.playableCount,
      error: r.error,
    })),
  };
  const reportPath = path.join(__dirname, '..', 'api-test-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(
    '\n' + colors.cyan('测试报告已保存到:') + ' api-test-report.json\n'
  );
}

main().catch((error) => {
  console.error(colors.red('测试脚本执行失败:'), error);
  process.exit(1);
});
