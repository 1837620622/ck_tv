// 播放页拿到的是这条稳定地址。签名只有几秒，不能写进详情缓存。
// 真正的 m3u8 在打开这一集时再向黄果要，分片仍由浏览器直接向源站拉。

export function huangguoPlaylistPath(id: string, episode: number): string {
  return `/api/huangguo/media/playlist.m3u8?id=${encodeURIComponent(
    id
  )}&ep=${episode}`;
}

export function parseHuangguoPlaylist(
  url: string
): { id: string; episode: number } | null {
  try {
    const parsed = new URL(url, 'https://cktv.local');
    if (parsed.pathname !== '/api/huangguo/media/playlist.m3u8') return null;
    const id = parsed.searchParams.get('id') || '';
    const episode = Number(parsed.searchParams.get('ep'));
    if (!/^\d{1,12}$/.test(id) || !Number.isInteger(episode) || episode < 1) {
      return null;
    }
    return { id, episode };
  } catch {
    return null;
  }
}

// 投屏和 AirPlay 要一条电视能直接打开的绝对地址。点下去的时候再取，不拿详情里的旧签名。
export async function freshHuangguoDirectUrl(url: string): Promise<string> {
  const parsed = parseHuangguoPlaylist(url);
  if (!parsed) return '';
  try {
    const response = await fetch(
      `${huangguoPlaylistPath(parsed.id, parsed.episode)}&format=url`,
      { cache: 'no-store' }
    );
    if (!response.ok) return '';
    const data = (await response.json()) as { url?: unknown };
    return typeof data.url === 'string' && /^https:\/\//.test(data.url)
      ? data.url
      : '';
  } catch {
    return '';
  }
}
