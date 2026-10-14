import {
  DEFAULT_VOLUME,
  readAutoNext,
  readVolume,
  writeAutoNext,
  writeVolume,
} from './player-prefs';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) =>
      data.has(key) ? (data.get(key) as string) : null,
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  } as Storage;
}

describe('player preferences', () => {
  it('falls back to the default volume when nothing usable is stored', () => {
    expect(readVolume(memoryStorage())).toBe(DEFAULT_VOLUME);
    expect(readVolume(memoryStorage({ player_volume: 'abc' }))).toBe(
      DEFAULT_VOLUME
    );
    expect(readVolume(null)).toBe(DEFAULT_VOLUME);
  });

  it('keeps a saved volume inside 0 to 1', () => {
    const store = memoryStorage();
    writeVolume(0.25, store);
    expect(readVolume(store)).toBe(0.25);
    writeVolume(3, store);
    expect(readVolume(store)).toBe(1);
    writeVolume(-1, store);
    expect(readVolume(store)).toBe(0);
    writeVolume(NaN, store);
    expect(readVolume(store)).toBe(0);
  });

  it('auto-next is on unless the user turned it off', () => {
    expect(readAutoNext(memoryStorage())).toBe(true);
    const store = memoryStorage();
    writeAutoNext(false, store);
    expect(readAutoNext(store)).toBe(false);
    writeAutoNext(true, store);
    expect(readAutoNext(store)).toBe(true);
  });

  it('survives a storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    expect(readVolume(broken)).toBe(DEFAULT_VOLUME);
    expect(readAutoNext(broken)).toBe(true);
    expect(() => writeVolume(0.5, broken)).not.toThrow();
    expect(() => writeAutoNext(false, broken)).not.toThrow();
  });
});
