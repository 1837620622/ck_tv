import { createScreenWakeLock } from './wake-lock';

// 可以手动决定什么时候 resolve 的申请，用来测试「申请中途被要求停止」
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSentinel() {
  return {
    released: false,
    release: jest.fn(async function (this: { released: boolean }) {
      this.released = true;
    }),
  };
}

function setup(request: jest.Mock) {
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible' as DocumentVisibilityState,
  }) as unknown as Document;
  const nav = { wakeLock: { request } } as unknown as Navigator;
  return { doc, nav };
}

describe('createScreenWakeLock', () => {
  it('requests a screen lock on enable and releases it on disable', async () => {
    const sentinel = fakeSentinel();
    const request = jest.fn(async () => sentinel);
    const { doc, nav } = setup(request);
    const lock = createScreenWakeLock(doc, nav);

    lock.enable();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');

    lock.disable();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('asks again when the page comes back to the foreground', async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const request = jest
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { doc, nav } = setup(request);
    const lock = createScreenWakeLock(doc, nav);
    lock.enable();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // 切到后台时浏览器会自己释放，这里模拟释放后再回到前台
    first.released = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(request).toHaveBeenCalledTimes(2);
    lock.disable();
  });

  it('releases a lock that was still being requested when disable ran', async () => {
    const pending = deferred<ReturnType<typeof fakeSentinel>>();
    const request = jest.fn(() => pending.promise);
    const { doc, nav } = setup(request);
    const lock = createScreenWakeLock(doc, nav);
    lock.enable();
    lock.disable();

    const sentinel = fakeSentinel();
    pending.resolve(sentinel);
    await Promise.resolve();
    await Promise.resolve();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the browser has no wake lock or refuses it', async () => {
    const { doc } = setup(jest.fn());
    expect(() =>
      createScreenWakeLock(doc, {} as Navigator).enable()
    ).not.toThrow();

    const refused = jest.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const lock = createScreenWakeLock(doc, {
      wakeLock: { request: refused },
    } as unknown as Navigator);
    expect(() => lock.enable()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(() => lock.disable()).not.toThrow();
  });
});

describe('createScreenWakeLock while a request is in flight', () => {
  it('does not send a second request for an enable that overlaps a pending one', async () => {
    const pending = deferred<ReturnType<typeof fakeSentinel>>();
    const request = jest.fn(() => pending.promise);
    const { doc, nav } = setup(request);
    const lock = createScreenWakeLock(doc, nav);
    lock.enable();
    lock.disable();
    lock.enable();
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(fakeSentinel());
    await Promise.resolve();
    await Promise.resolve();
    lock.disable();
  });

  it('can request again after a synchronous failure', async () => {
    const request = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sync failure');
      })
      .mockResolvedValueOnce(fakeSentinel());
    const { doc, nav } = setup(request);
    const lock = createScreenWakeLock(doc, nav);
    lock.enable();
    await Promise.resolve();
    await Promise.resolve();
    lock.disable();
    lock.enable();
    expect(request).toHaveBeenCalledTimes(2);
    lock.disable();
  });
});
