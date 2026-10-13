// 防诈骗提醒的共用常量和存储逻辑。这里不带 'use client'，布局（服务端组件）也会引用初始化脚本。

export const SCAM_NOTICE_KEY = 'scam-notice-hidden-until';
export const SCAM_NOTICE_HIDE_MS = 7 * 24 * 60 * 60 * 1000;
// 关闭后挂在 <html> 上，CSS 据此隐藏所有提醒
export const SCAM_NOTICE_HIDDEN_ATTR = 'data-scam-notice-hidden';

// 存储不可用（隐私模式、被禁用）时视为未关闭，每次都显示，不影响播放
export function isNoticeHidden(now = Date.now()): boolean {
  try {
    const until = Number(window.localStorage.getItem(SCAM_NOTICE_KEY) || 0);
    return until > now;
  } catch {
    return false;
  }
}

export function hideNotice(now = Date.now()): void {
  try {
    window.localStorage.setItem(
      SCAM_NOTICE_KEY,
      String(now + SCAM_NOTICE_HIDE_MS)
    );
  } catch {
    // 存储不可用时只是本次关不掉，下次打开仍会显示
  }
}

// 在首屏绘制前执行：已关闭则给 <html> 加属性，提醒在第一帧就不出现，不会挂载后跳动
export const SCAM_NOTICE_INIT_SCRIPT = `(function(){try{var u=Number(localStorage.getItem('${SCAM_NOTICE_KEY}')||0);if(u>Date.now()){document.documentElement.setAttribute('${SCAM_NOTICE_HIDDEN_ATTR}','')}}catch(e){}})();`;
