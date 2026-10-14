import { publicHttpUrl } from './safe-url';

describe('publicHttpUrl', () => {
  it('allows ordinary public http and https addresses', () => {
    expect(
      publicHttpUrl('https://img1.doubanio.com/view/photo.jpg')?.hostname
    ).toBe('img1.doubanio.com');
    expect(publicHttpUrl('http://example.com/a.jpg')).not.toBeNull();
    expect(publicHttpUrl('https://1.2.3.4.example.com/a.jpg')).not.toBeNull();
  });

  it('blocks loopback, private and metadata addresses written as IPs', () => {
    expect(publicHttpUrl('http://127.0.0.1/')).toBeNull();
    expect(publicHttpUrl('http://10.1.2.3/')).toBeNull();
    expect(publicHttpUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(publicHttpUrl('http://[::1]/')).toBeNull();
  });

  it('blocks private addresses written inside a hostname', () => {
    expect(publicHttpUrl('http://127.0.0.1.nip.io/')).toBeNull();
    expect(publicHttpUrl('http://10-0-0-1.sslip.io/a.jpg')).toBeNull();
    expect(publicHttpUrl('https://169.254.169.254.nip.io/')).toBeNull();
  });

  it('still finds a private address that follows a public-looking label', () => {
    expect(publicHttpUrl('http://1.127.0.0.1.nip.io/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://1-127-0-0-1.sslip.io/')).toBeNull();
    expect(publicHttpUrl('http://1.10.0.0.1.nip.io/')).toBeNull();
  });

  it('blocks localhost, internal names, credentials and other schemes', () => {
    expect(publicHttpUrl('http://localhost/')).toBeNull();
    expect(publicHttpUrl('http://db.internal/')).toBeNull();
    expect(publicHttpUrl('https://user:pass@example.com/')).toBeNull();
    expect(publicHttpUrl('ftp://example.com/a.jpg')).toBeNull();
    expect(publicHttpUrl('not a url')).toBeNull();
  });
});
