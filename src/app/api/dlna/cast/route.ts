// ================================
// DLNA 投屏控制 API
// 使用 UPnP 协议向 DLNA 设备发送视频播放指令
// ================================

import { NextRequest, NextResponse } from 'next/server';

// 投屏请求参数
interface CastRequest {
  deviceHost: string;
  videoUrl: string;
  title?: string;
}

// 向 DLNA 设备投屏视频
async function castToDevice(deviceLocation: string, videoUrl: string, title: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    try {
      // 动态导入 upnp-mediarenderer-client
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const MediaRendererClient = require('upnp-mediarenderer-client');

      // 创建客户端连接
      const client = new MediaRendererClient(deviceLocation);

      // 设置超时
      const timeout = setTimeout(() => {
        resolve({
          success: false,
          message: '连接设备超时，请检查设备是否在线',
        });
      }, 10000); // 10 秒超时

      // 根据视频 URL 判断内容类型
      let contentType = 'video/mp4';
      if (videoUrl.includes('.m3u8') || videoUrl.includes('m3u8')) {
        contentType = 'application/x-mpegURL';
      } else if (videoUrl.includes('.mp4')) {
        contentType = 'video/mp4';
      } else if (videoUrl.includes('.mkv')) {
        contentType = 'video/x-matroska';
      } else if (videoUrl.includes('.avi')) {
        contentType = 'video/avi';
      } else if (videoUrl.includes('.flv')) {
        contentType = 'video/x-flv';
      }

      // 投屏选项
      const options = {
        autoplay: true,
        contentType: contentType,
        metadata: {
          title: title || '视频播放',
          type: 'video',
        },
      };

      // 加载并播放视频
      client.load(videoUrl, options, (err: Error | null) => {
        clearTimeout(timeout);

        if (err) {
          console.error('DLNA 投屏错误:', err);
          resolve({
            success: false,
            message: `投屏失败: ${err.message}`,
          });
        } else {
          resolve({
            success: true,
            message: '投屏成功！视频正在播放',
          });
        }
      });

      // 监听播放状态
      client.on('playing', () => {
        console.log('DLNA: 视频正在播放');
      });

      client.on('error', (err: Error) => {
        clearTimeout(timeout);
        console.error('DLNA 客户端错误:', err);
        resolve({
          success: false,
          message: `设备连接错误: ${err.message}`,
        });
      });

    } catch (error) {
      console.error('DLNA 投屏异常:', error);
      resolve({
        success: false,
        message: '投屏功能初始化失败',
      });
    }
  });
}

// 根据设备 IP 获取设备描述 URL
async function getDeviceLocation(deviceHost: string): Promise<string | null> {
  try {
    // 尝试常见的 DLNA 设备描述路径
    const commonPaths = [
      '/description.xml',
      '/upnp/desc.xml',
      '/rootDesc.xml',
      '/DeviceDescription.xml',
      '/dmr.xml',
    ];

    for (const path of commonPaths) {
      try {
        const url = `http://${deviceHost}:${49152}${path}`;
        const response = await fetch(url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          return url;
        }
      } catch {
        // 继续尝试下一个路径
      }
    }

    // 尝试标准端口
    const standardPorts = [49152, 8008, 8080, 1900];
    for (const port of standardPorts) {
      for (const path of commonPaths) {
        try {
          const url = `http://${deviceHost}:${port}${path}`;
          const response = await fetch(url, {
            method: 'HEAD',
            signal: AbortSignal.timeout(1000),
          });
          if (response.ok) {
            return url;
          }
        } catch {
          // 继续尝试
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// 处理 POST 请求 - 投屏到设备
export async function POST(request: NextRequest) {
  try {
    const body: CastRequest = await request.json();
    const { deviceHost, videoUrl, title } = body;

    // 参数验证
    if (!deviceHost) {
      return NextResponse.json({
        success: false,
        error: '请选择投屏设备',
      }, { status: 400 });
    }

    if (!videoUrl) {
      return NextResponse.json({
        success: false,
        error: '请先播放视频',
      }, { status: 400 });
    }

    // 获取设备描述 URL
    let deviceLocation = body.deviceHost;

    // 如果只提供了 IP，尝试发现设备描述 URL
    if (!deviceHost.includes('http')) {
      const location = await getDeviceLocation(deviceHost);
      if (!location) {
        return NextResponse.json({
          success: false,
          error: '无法连接到设备，请确保设备已开启 DLNA',
        }, { status: 404 });
      }
      deviceLocation = location;
    }

    // 执行投屏
    const result = await castToDevice(deviceLocation, videoUrl, title || '视频播放');

    if (result.success) {
      return NextResponse.json({
        success: true,
        message: result.message,
      });
    } else {
      return NextResponse.json({
        success: false,
        error: result.message,
      }, { status: 500 });
    }

  } catch (error) {
    console.error('DLNA 投屏 API 错误:', error);
    return NextResponse.json({
      success: false,
      error: '投屏请求处理失败',
    }, { status: 500 });
  }
}
