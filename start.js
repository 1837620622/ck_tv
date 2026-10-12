#!/usr/bin/env node

/* eslint-disable no-console,@typescript-eslint/no-var-requires */
const crypto = require('crypto');
const http = require('http');
const path = require('path');

// /api/cron 需要 CRON_SECRET。未显式配置时，生成一个只存在于本进程里的随机值：
// 本脚本和 Next 服务在同一个进程，只有这里的定时调用知道它，外部请求调不动。
if (!process.env.CRON_SECRET) {
  process.env.CRON_SECRET = crypto.randomBytes(32).toString('hex');
}

// 调用 generate-manifest.js 生成 manifest.json
function generateManifest() {
  console.log('Generating manifest.json for Docker deployment...');

  try {
    const generateManifestScript = path.join(
      __dirname,
      'scripts',
      'generate-manifest.js'
    );
    require(generateManifestScript);
  } catch (error) {
    console.error('❌ Error calling generate-manifest.js:', error);
    throw error;
  }
}

generateManifest();

// 直接在当前进程中启动 standalone Server（`server.js`）
require('./server.js');

// 每 1 秒轮询一次，直到请求成功
const TARGET_URL = `http://${process.env.HOSTNAME || 'localhost'}:${
  process.env.PORT || 3000
}/login`;

const intervalId = setInterval(() => {
  console.log(`Fetching ${TARGET_URL} ...`);

  const req = http.get(TARGET_URL, (res) => {
    // 当返回 2xx 状态码时认为成功，然后停止轮询
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log('Server is up, stop polling.');
      clearInterval(intervalId);

      // 服务器启动后，立即执行一次 cron 任务
      executeCronJob();

      // 然后设置每小时执行一次 cron 任务
      setInterval(() => {
        executeCronJob();
      }, 60 * 60 * 1000); // 每小时执行一次
    }
  });

  req.setTimeout(2000, () => {
    req.destroy();
  });
}, 1000);

// 执行 cron 任务的函数
function executeCronJob() {
  const cronUrl = `http://${process.env.HOSTNAME || 'localhost'}:${
    process.env.PORT || 3000
  }/api/cron`;

  console.log(`Executing cron job: ${cronUrl}`);

  const options = {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  };
  const req = http.get(cronUrl, options, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        console.log('Cron job executed successfully:', data);
      } else {
        console.error('Cron job failed:', res.statusCode, data);
      }
    });
  });

  req.on('error', (err) => {
    console.error('Error executing cron job:', err);
  });

  req.setTimeout(30000, () => {
    console.error('Cron job timeout');
    req.destroy();
  });
}
