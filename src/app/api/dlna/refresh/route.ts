// ================================
// DLNA 设备发现 API
// 使用 SSDP 协议搜索局域网内的 DLNA/UPnP 设备
// ================================

import { NextResponse } from 'next/server';

// DLNA 设备缓存
interface DLNADevice {
  name: string;
  host: string;
  location: string;
  server?: string;
}

// 全局设备缓存（生产环境建议使用 Redis）
let cachedDevices: DLNADevice[] = [];
let lastScanTime = 0;
const CACHE_DURATION = 30000; // 30 秒缓存

// SSDP 设备发现（仅在 Node.js 环境可用）
async function discoverDevices(): Promise<DLNADevice[]> {
  return new Promise((resolve) => {
    const devices: DLNADevice[] = [];

    try {
      // 动态导入 node-ssdp（避免客户端打包问题）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Client } = require('node-ssdp');
      const client = new Client();

      // 设置超时
      const timeout = setTimeout(() => {
        client.stop();
        resolve(devices);
      }, 5000); // 5 秒超时

      // 监听设备响应
      client.on('response', (headers: Record<string, string>, statusCode: number, rinfo: { address: string }) => {
        if (statusCode === 200 && headers.LOCATION) {
          // 过滤 MediaRenderer 设备
          const st = headers.ST || '';
          if (st.includes('MediaRenderer') || st.includes('AVTransport') || st === 'ssdp:all') {
            const device: DLNADevice = {
              name: headers.SERVER || headers.USN || `设备 ${rinfo.address}`,
              host: rinfo.address,
              location: headers.LOCATION,
              server: headers.SERVER,
            };

            // 避免重复
            if (!devices.find(d => d.host === device.host)) {
              devices.push(device);
            }
          }
        }
      });

      // 搜索 MediaRenderer 设备
      client.search('urn:schemas-upnp-org:device:MediaRenderer:1');

      // 同时搜索所有 UPnP 设备
      setTimeout(() => {
        client.search('ssdp:all');
      }, 1000);

      // 清理
      client.on('error', () => {
        clearTimeout(timeout);
        resolve(devices);
      });

    } catch (error) {
      console.error('SSDP 发现错误:', error);
      resolve(devices);
    }
  });
}

// 处理 POST 请求 - 刷新设备列表
export async function POST() {
  try {
    const now = Date.now();

    // 检查缓存
    if (now - lastScanTime < CACHE_DURATION && cachedDevices.length > 0) {
      return NextResponse.json({
        success: true,
        devices: cachedDevices,
        cached: true,
      });
    }

    // 执行设备发现
    const devices = await discoverDevices();

    // 更新缓存
    cachedDevices = devices;
    lastScanTime = now;

    return NextResponse.json({
      success: true,
      devices: devices,
      cached: false,
    });

  } catch (error) {
    console.error('DLNA 刷新错误:', error);
    return NextResponse.json({
      success: false,
      error: '设备搜索失败',
      devices: [],
    }, { status: 500 });
  }
}

// 处理 GET 请求 - 获取缓存的设备列表
export async function GET() {
  return NextResponse.json({
    success: true,
    devices: cachedDevices,
    cached: true,
  });
}
