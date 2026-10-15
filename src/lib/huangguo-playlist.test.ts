import {
  encodeHuangguoRequest,
  httpMessageComplete,
  huangguoUpstreamPath,
  preparePlaylist,
  readHttpMessage,
} from './huangguo-playlist';

function encode(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

describe('huangguoUpstreamPath', () => {
  it('keeps the signed path on the playlist host', () => {
    expect(
      huangguoUpstreamPath(
        'https://yd-hls.hzjvlo.cn/videos/ep1.m3u8?auth_key=1'
      )
    ).toBe('/videos/ep1.m3u8?auth_key=1');
  });

  it('rejects other hosts, plain http, and credentials', () => {
    expect(huangguoUpstreamPath('https://cdn.example/videos/ep1.m3u8')).toBe(
      ''
    );
    expect(
      huangguoUpstreamPath('http://yd-hls.hzjvlo.cn/videos/ep1.m3u8')
    ).toBe('');
    expect(
      huangguoUpstreamPath('https://user:pass@yd-hls.hzjvlo.cn/videos/ep1.m3u8')
    ).toBe('');
  });
});

describe('encodeHuangguoRequest', () => {
  it('ends each header line with CR LF', () => {
    const bytes = encodeHuangguoRequest('/videos/ep1.m3u8?auth_key=1');
    let text = '';
    bytes.forEach((code) => {
      text += String.fromCharCode(code);
    });
    expect(
      text.startsWith('GET /videos/ep1.m3u8?auth_key=1 HTTP/1.1\r\n')
    ).toBe(true);
    expect(text).toContain('Host: yd-hls.hzjvlo.cn\r\n');
    expect(text.endsWith('\r\n\r\n')).toBe(true);
    expect(text).not.toContain('Origin');
    expect(text).not.toContain('CF-Worker');
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        expect(text.charCodeAt(index - 1)).toBe(13);
      }
    }
  });
});

describe('readHttpMessage', () => {
  it('reads a content-length body and ignores bytes after it', () => {
    const raw = encode(
      'HTTP/1.1 200 OK\r\nContent-Length: 16\r\n\r\n#EXTM3U\nfile.ts\nEXTRA'
    );
    expect(readHttpMessage(raw)).toEqual({
      status: 200,
      body: '#EXTM3U\nfile.ts\n',
      location: '',
    });
    expect(httpMessageComplete(raw)).toBe(true);
    expect(httpMessageComplete(raw.subarray(0, 40))).toBe(false);
  });

  it('reads a chunked body', () => {
    const raw = encode(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n#EXTM3U\r\n0\r\n\r\n'
    );
    expect(readHttpMessage(raw)?.body).toBe('#EXTM3U');
  });

  it('reads a redirect location', () => {
    const raw = encode(
      'HTTP/1.1 302 Found\r\nLocation: /next.m3u8?auth_key=2\r\nContent-Length: 0\r\n\r\n'
    );
    expect(readHttpMessage(raw)).toEqual({
      status: 302,
      body: '',
      location: '/next.m3u8?auth_key=2',
    });
  });
});

describe('preparePlaylist', () => {
  const base = 'https://yd-hls.hzjvlo.cn/videos/ep1.m3u8?auth_key=1';

  it('makes relative segments and keys absolute on the source host', () => {
    const text = preparePlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"\nseg.ts\n',
      base
    );
    expect(text).toContain('URI="https://yd-hls.hzjvlo.cn/videos/key.key"');
    expect(text).toContain('https://yd-hls.hzjvlo.cn/videos/seg.ts');
  });

  it('keeps absolute segment urls and drops the known decoy', () => {
    expect(
      preparePlaylist('#EXTM3U\nhttps://tp4.drleao.cn/a/111.ts\n', base)
    ).toContain('https://tp4.drleao.cn/a/111.ts');
    expect(
      preparePlaylist(
        '#EXTM3U\nhttps://tp4.drleao.cn/853acaba4721cceab535b64e6831f05a0.ts\n',
        base
      )
    ).toBe('');
    expect(preparePlaylist('not a playlist', base)).toBe('');
  });
});
