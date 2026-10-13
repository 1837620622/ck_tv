import {
  hideNotice,
  isNoticeHidden,
  SCAM_NOTICE_HIDDEN_ATTR,
  SCAM_NOTICE_INIT_SCRIPT,
  SCAM_NOTICE_KEY,
} from './scam-notice';

const DAY = 24 * 60 * 60 * 1000;

describe('scam notice dismissal', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute(SCAM_NOTICE_HIDDEN_ATTR);
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

  it('init script marks <html> before paint when the notice was dismissed', () => {
    window.localStorage.setItem(SCAM_NOTICE_KEY, String(Date.now() + DAY));
    new Function(SCAM_NOTICE_INIT_SCRIPT)();
    expect(document.documentElement.hasAttribute(SCAM_NOTICE_HIDDEN_ATTR)).toBe(
      true
    );
  });

  it('init script leaves <html> alone when the notice is not dismissed', () => {
    new Function(SCAM_NOTICE_INIT_SCRIPT)();
    expect(document.documentElement.hasAttribute(SCAM_NOTICE_HIDDEN_ATTR)).toBe(
      false
    );
  });
});
