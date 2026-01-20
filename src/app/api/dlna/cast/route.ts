// ================================
// DLNA 投屏控制 API
// 注意：Cloudflare Edge Runtime 不支持 UPnP
// 需要 Node.js 环境才能使用 upnp-mediarenderer-client
// ================================

import { NextResponse } from 'next/server';

// Cloudflare Pages 需要 Edge Runtime
export const runtime = 'edge';

// Edge Runtime 不支持 UPnP/DLNA 投屏
// 返回提示信息，建议用户使用第三方投屏 App

export async function POST() {
  return NextResponse.json({
    success: false,
    error: 'DLNA 投屏需要使用第三方 App（如：乐播投屏、AirScreen）',
    message: '请在电视上安装投屏 App，然后复制视频链接投屏',
  });
}
