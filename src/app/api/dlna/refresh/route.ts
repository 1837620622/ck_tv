// ================================
// DLNA 设备发现 API
// 注意：Cloudflare Edge Runtime 不支持 UDP 套接字
// ================================

import { NextResponse } from 'next/server';

export const runtime = 'edge';

// Edge Runtime 不支持 SSDP/UDP，返回提示信息
export async function POST() {
  return NextResponse.json({
    success: false,
    error: 'DLNA 投屏需要使用第三方 App（如：乐播投屏、AirScreen）',
    devices: [],
    message: '请在电视上安装投屏 App，然后复制视频链接投屏',
  });
}

export async function GET() {
  return NextResponse.json({
    success: false,
    error: 'DLNA 投屏需要使用第三方 App',
    devices: [],
  });
}
