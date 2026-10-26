import {
  clearLegacyCaches,
  isChunkLoadError,
  LEGACY_SW_CACHES,
  reloadOnce,
} from './app-health';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe('isChunkLoadError', () => {
  it('recognises the errors browsers and webpack throw for a missing chunk', () => {
    const named = new Error('Loading chunk 931 failed.');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
    expect(
      isChunkLoadError(new Error('Loading CSS chunk app-pages failed'))
    ).toBe(true);
    expect(
      isChunkLoadError(
        new TypeError('Failed to fetch dynamically imported module: /x.js')
      )
    ).toBe(true);
    expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('Network request failed'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });
});

describe('reloadOnce', () => {
  it('reloads, then refuses again within a minute', () => {
    const storage = memoryStorage();
    const reload = jest.fn();
    expect(reloadOnce({ storage, reload, now: 1_000_000 })).toBe(true);
    expect(reloadOnce({ storage, reload, now: 1_030_000 })).toBe(false);
    expect(reloadOnce({ storage, reload, now: 1_061_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload when it cannot remember having reloaded', () => {
    const reload = jest.fn();
    expect(reloadOnce({ storage: null, reload, now: 1 })).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(reloadOnce({ storage: broken, reload, now: 1 })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('clearLegacyCaches', () => {
  it('deletes only the caches the old service worker used', async () => {
    const deleted: string[] = [];
    const store = {
      keys: async () => [
        'cross-origin',
        'apis',
        'workbox-precache-v2-https://tv.example/',
        'something-else',
      ],
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    };
    expect(await clearLegacyCaches(store)).toBe(2);
    expect(deleted.sort()).toEqual(['apis', 'cross-origin']);
    expect(LEGACY_SW_CACHES).not.toContain('workbox-precache-v2');
  });

  it('does nothing without Cache Storage', async () => {
    expect(await clearLegacyCaches(undefined)).toBe(0);
  });
});
