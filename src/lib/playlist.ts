// 只解析 m3u8 文本里的分辨率。不请求分片。

export function playlistHeight(text: string): number {
  if (!text.includes('#EXTM3U')) return 0;
  let height = 0;
  const pattern = /RESOLUTION=\d+x(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > height) height = value;
  }
  return height;
}

export function qualityText(height: number): string {
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  if (height > 0) return `${height}p`;
  return '';
}
