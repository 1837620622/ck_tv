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

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: process.env.NODE_ENV === 'development',
  register: true,
  skipWaiting: true,
});

module.exports = withPWA(nextConfig);
