import {
  freshHuangguoDirectUrl,
  huangguoPlaylistPath,
  parseHuangguoPlaylist,
} from './huangguo-media';

describe('huangguo playlist path', () => {
  it('keeps episode numbers in the path so a switch is a different url', () => {
    const first = huangguoPlaylistPath('12', 1);
    const second = huangguoPlaylistPath('12', 2);
    expect(first).toBe('/api/huangguo/media/playlist.m3u8?id=12&ep=1');
    expect(second).not.toBe(first);
    expect(parseHuangguoPlaylist(second)).toEqual({ id: '12', episode: 2 });
  });

  it('rejects addresses that are not the huangguo playlist entry', () => {
    expect(
      parseHuangguoPlaylist('https://cdn.example/a.m3u8?id=12&ep=1')
    ).toBeNull();
    expect(
      parseHuangguoPlaylist('/api/huangguo/media/playlist.m3u8?id=x&ep=1')
    ).toBeNull();
  });

  it('reads a fresh absolute url and ignores anything else in the payload', async () => {
    const target = huangguoPlaylistPath('12', 3);
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        url: 'https://cdn.example/ep3.m3u8?auth_key=1',
        video_key: 'secret',
      }),
    })) as unknown as typeof fetch;
    await expect(freshHuangguoDirectUrl(target)).resolves.toBe(
      'https://cdn.example/ep3.m3u8?auth_key=1'
    );
    const called = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(called).toContain('format=url');
    expect(called).toContain('ep=3');
    delete (global as { fetch?: unknown }).fetch;
  });
});
