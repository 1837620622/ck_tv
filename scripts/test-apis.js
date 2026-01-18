#!/usr/bin/env node
/**
 * ============================================================
 * CKTV 资源站 API 接口批量测试脚本
 * ============================================================
 * 功能：批量测试 config.json 中所有 API 接口的可用性
 * 作者：传康KK | Vx：1837620622 | 邮箱：2040168455@qq.com
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// 配置参数
// ------------------------------------------------------------
const CONFIG = {
  timeout: 8000,           // 请求超时时间（毫秒）
  concurrency: 10,         // 并发请求数
  retryCount: 1,           // 失败重试次数
  testQuery: '?ac=list',   // 测试查询参数
};

// ------------------------------------------------------------
// 颜色输出工具
// ------------------------------------------------------------
const colors = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  gray: (text) => `\x1b[90m${text}\x1b[0m`,
};

// ------------------------------------------------------------
// 测试单个 API 接口
// ------------------------------------------------------------
async function testApi(key, apiUrl, retries = CONFIG.retryCount) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

  const startTime = Date.now();

  try {
    const response = await fetch(apiUrl + CONFIG.testQuery, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    });

    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;

    if (response.ok) {
      const data = await response.json();
      const hasData = data && data.list && Array.isArray(data.list);
      const count = hasData ? data.list.length : 0;

      return {
        key,
        api: apiUrl,
        status: 'success',
        httpCode: response.status,
        time: elapsed,
        dataCount: count,
        hasValidData: hasData && count > 0,
      };
    } else {
      return {
        key,
        api: apiUrl,
        status: 'http_error',
        httpCode: response.status,
        time: elapsed,
        error: `HTTP ${response.status}`,
      };
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;

    // 重试逻辑
    if (retries > 0 && error.name !== 'AbortError') {
      return testApi(key, apiUrl, retries - 1);
    }

    return {
      key,
      api: apiUrl,
      status: 'error',
      time: elapsed,
      error: error.name === 'AbortError' ? '超时' : error.message,
    };
  }
}

// ------------------------------------------------------------
// 并发控制器
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

// ------------------------------------------------------------
// 主函数
// ------------------------------------------------------------
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log(colors.cyan('  CKTV 资源站 API 接口批量测试'));
  console.log('='.repeat(60) + '\n');

  // 读取配置文件
  const configPath = path.join(__dirname, '..', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error(colors.red('错误: 找不到 config.json 文件'));
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const apiSites = config.api_site;
  const apiKeys = Object.keys(apiSites);

  console.log(`${colors.cyan('发现接口数量:')} ${apiKeys.length}`);
  console.log(`${colors.cyan('并发数:')} ${CONFIG.concurrency}`);
  console.log(`${colors.cyan('超时时间:')} ${CONFIG.timeout}ms`);
  console.log('\n' + '-'.repeat(60) + '\n');
  console.log('开始测试...\n');

  // 创建测试任务
  const tasks = apiKeys.map((key) => {
    return async () => {
      const site = apiSites[key];
      const result = await testApi(key, site.api);

      // 实时输出结果
      const status = result.status === 'success' && result.hasValidData
        ? colors.green('✓ 可用')
        : result.status === 'success'
          ? colors.yellow('⚠ 无数据')
          : colors.red('✗ 失败');

      const timeStr = colors.gray(`${result.time}ms`);
      const name = site.name.padEnd(12);

      console.log(`  ${status} ${name} ${colors.gray(key)} ${timeStr}`);

      return { ...result, name: site.name };
    };
  });

  const startTime = Date.now();
  const results = await runWithConcurrency(tasks, CONFIG.concurrency);
  const totalTime = Date.now() - startTime;

  // ------------------------------------------------------------
  // 统计结果
  // ------------------------------------------------------------
  const successful = results.filter((r) => r.status === 'success' && r.hasValidData);
  const noData = results.filter((r) => r.status === 'success' && !r.hasValidData);
  const failed = results.filter((r) => r.status !== 'success');

  console.log('\n' + '='.repeat(60));
  console.log(colors.cyan('  测试结果统计'));
  console.log('='.repeat(60) + '\n');

  console.log(`  ${colors.green('✓ 可用接口:')}     ${successful.length}`);
  console.log(`  ${colors.yellow('⚠ 无数据接口:')}   ${noData.length}`);
  console.log(`  ${colors.red('✗ 失败接口:')}     ${failed.length}`);
  console.log(`  ${colors.cyan('总计:')}           ${results.length}`);
  console.log(`  ${colors.gray('耗时:')}           ${(totalTime / 1000).toFixed(2)}s`);

  // 输出失败详情
  if (failed.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(colors.red('\n失败接口详情:\n'));

    failed.forEach((r) => {
      console.log(`  ${colors.red('✗')} ${r.name} (${r.key})`);
      console.log(`    ${colors.gray('API:')} ${r.api}`);
      console.log(`    ${colors.gray('错误:')} ${r.error}`);
      console.log();
    });
  }

  // 输出可用接口列表
  if (successful.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log(colors.green('\n可用接口列表:\n'));

    successful
      .sort((a, b) => a.time - b.time)
      .forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.name} (${r.key}) - ${r.time}ms - ${r.dataCount}条数据`);
      });
  }

  console.log('\n' + '='.repeat(60) + '\n');

  // 生成报告文件
  const reportPath = path.join(__dirname, '..', 'api-test-report.json');
  const report = {
    testTime: new Date().toISOString(),
    totalApis: results.length,
    successCount: successful.length,
    noDataCount: noData.length,
    failedCount: failed.length,
    totalTimeMs: totalTime,
    results: results.map((r) => ({
      key: r.key,
      name: r.name,
      api: r.api,
      status: r.status,
      httpCode: r.httpCode,
      timeMs: r.time,
      dataCount: r.dataCount,
      hasValidData: r.hasValidData,
      error: r.error,
    })),
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`${colors.cyan('测试报告已保存到:')} api-test-report.json\n`);
}

// ------------------------------------------------------------
// 运行主函数
// ------------------------------------------------------------
main().catch((error) => {
  console.error(colors.red('测试脚本执行失败:'), error);
  process.exit(1);
});
