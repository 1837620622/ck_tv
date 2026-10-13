import { hideNotice, isNoticeHidden } from './ScamNotice';

const DAY = 24 * 60 * 60 * 1000;

describe('ScamNotice dismissal', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('shows the notice until the user dismisses it', () => {
    expect(isNoticeHidden(1_000)).toBe(false);
    hideNotice(1_000);
    expect(isNoticeHidden(1_000)).toBe(true);
  });

  it('shows the notice again after seven days', () => {
    hideNotice(0);
    expect(isNoticeHidden(6 * DAY)).toBe(true);
    expect(isNoticeHidden(8 * DAY)).toBe(false);
  });

  it('keeps showing the notice when storage is unavailable', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(isNoticeHidden()).toBe(false);
  });

  it('does not throw when dismissing fails to persist', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied');
    });
    expect(() => hideNotice()).not.toThrow();
  });
});
