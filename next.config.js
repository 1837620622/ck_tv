/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */
const nextConfig = {
  output: 'standalone',
  eslint: {
    dirs: ['src'],
  },

  reactStrictMode: false,
  swcMinify: true,

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  async headers() {
    const cache = [
      {
        key: 'Cache-Control',
        value: 'public, max-age=86400, s-maxage=604800',
      },
    ];
    return [
      { source: '/logo.png', headers: cache },
      { source: '/favicon.ico', headers: cache },
      { source: '/icons/:file', headers: cache },
    ];
  },

  webpack(config) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    // 原始套接字由运行时提供。打成普通包会在构建期解析 cloudflare: 协议失败。
    const socketsExternal = ({ request }, callback) => {
      if (request === 'cloudflare:sockets') {
        return callback(null, 'commonjs cloudflare:sockets');
      }
      callback();
    };
    if (Array.isArray(config.externals)) {
      config.externals.push(socketsExternal);
    } else if (typeof config.externals === 'function') {
      const previous = config.externals;
      config.externals = (data, callback) => {
        if (data.request === 'cloudflare:sockets') {
          return callback(null, 'commonjs cloudflare:sockets');
        }
        return previous(data, callback);
      };
    } else {
      config.externals = [socketsExternal];
    }

    return config;
  },
};

// Service Worker 只用来让站点能「添加到主屏幕」，不做离线缓存：
// - 不预缓存构建产物和截图。以前每个新访客装 SW 时，后台要再下载约 20 MB
//   （public 里三张截图就有 18 MB），和首页、正片抢带宽；其中任何一个文件下载失败，
//   SW 安装失败，下次打开又从头下载。_next/static 有一年的 immutable 缓存头，浏览器自己会缓存。
// - 不登记运行时缓存。以前接口、页面和所有跨域请求都会被 SW 拦下：每个视频分片都要过一遍 SW
//   并写进 Cache Storage；接口和页面超过 10 秒就返回旧内容；新版本上线后还会拿旧页面去加载
//   已经不存在的脚本。现在这些请求都直接走浏览器，门控接口自然也不会被缓存。
// - 不缓存首页（cacheStartUrl、dynamicStartUrl），原因同上。dynamicStartUrl 默认开着时，
//   页面每次回到首页还会在后台再拉一遍首页 HTML 存进缓存。
const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
  cacheStartUrl: false,
  dynamicStartUrl: false,
  buildExcludes: [/.*/],
  publicExcludes: ['!noprecache/**/*', '!screenshot*.png', '!ck.jpg'],
  runtimeCaching: [],
});

module.exports = withPWA(nextConfig);
