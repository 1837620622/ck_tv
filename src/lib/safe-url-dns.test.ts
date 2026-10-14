import { fetchPublic, publicAddress, publicHttpUrl } from './safe-url';

describe('single-label hostnames', () => {
  it('rejects names that only resolve inside a private network', () => {
    expect(publicHttpUrl('http://minio/bucket/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://minio:9000/x.jpg')).toBeNull();
    expect(publicHttpUrl('http://redis/')).toBeNull();
  });

  it('still allows ordinary public domains', () => {
    expect(publicHttpUrl('https://example.com/a.jpg')).not.toBeNull();
    expect(publicHttpUrl('https://img1.doubanio.com/a.jpg')).not.toBeNull();
  });
});

describe('publicAddress', () => {
  it('accepts public IPv4 and IPv6 addresses', () => {
    expect(publicAddress('93.184.216.34')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects private, loopback, link-local and metadata addresses', () => {
    expect(publicAddress('169.254.169.254')).toBe(false);
    expect(publicAddress('10.0.0.5')).toBe(false);
    expect(publicAddress('127.0.0.1')).toBe(false);
    expect(publicAddress('192.168.1.10')).toBe(false);
    expect(publicAddress('::1')).toBe(false);
    expect(publicAddress('fd00::1')).toBe(false);
    expect(publicAddress('::ffff:10.0.0.5')).toBe(false);
  });
});

describe('fetchPublic with a host resolver (Docker path)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn(async () => ({
      status: 200,
      headers: { get: () => null },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('refuses a public-looking domain that resolves to the metadata address', async () => {
    const resolve = jest.fn(async () => ['169.254.169.254']);
    const result = await fetchPublic(
      new URL('http://meta.attacker.test/latest/meta-data/'),
      {},
      resolve
    );
    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledWith('meta.attacker.test');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when any one of several answers is private', async () => {
    const result = await fetchPublic(
      new URL('https://mixed.example.test/a.jpg'),
      {},
      async () => ['93.184.216.34', '10.0.0.5']
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when resolution fails or returns nothing', async () => {
    const failing = await fetchPublic(
      new URL('https://a.example.test/'),
      {},
      async () => {
        throw new Error('ENOTFOUND');
      }
    );
    const empty = await fetchPublic(
      new URL('https://b.example.test/'),
      {},
      async () => []
    );
    expect(failing).toBeNull();
    expect(empty).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a domain whose answers are all public', async () => {
    const result = await fetchPublic(
      new URL('https://ok.example.test/a.jpg'),
      {},
      async () => ['93.184.216.34']
    );
    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('checks the resolver again on every redirect hop', async () => {
    fetchMock
      .mockResolvedValueOnce({
        status: 302,
        headers: {
          get: (name: string) =>
            name === 'location' ? 'https://rebind.example.test/x' : null,
        },
      })
      .mockResolvedValueOnce({ status: 200, headers: { get: () => null } });
    const resolve = jest
      .fn()
      .mockResolvedValueOnce(['93.184.216.34'])
      .mockResolvedValueOnce(['10.0.0.5']);
    const result = await fetchPublic(
      new URL('https://start.example.test/'),
      {},
      resolve
    );
    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the DNS check when no resolver is supplied (edge runtime)', async () => {
    const result = await fetchPublic(
      new URL('https://ok.example.test/a.jpg'),
      {},
      null
    );
    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
