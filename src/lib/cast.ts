// Google Cast（Chromecast）发送端。投屏的是 .m3u8 地址，由电视自己去拉流。
// 页面里的 hls.js 用 MSE 播放，video.src 是 blob 地址，电视拿不到，所以不能用 video.remote 投屏。

export const CAST_SDK_URL =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
export const HLS_CONTENT_TYPE = 'application/x-mpegurl';
const SDK_TIMEOUT_MS = 15000;

// 只声明本模块用到的 Cast SDK 接口，不用 any
interface CastSession {
  loadMedia(request: unknown): Promise<void>;
  endSession(stopCasting: boolean): void;
  getCastDevice?(): { friendlyName?: string } | null;
}

interface CastContextLike {
  setOptions(options: Record<string, unknown>): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSession | null;
  getCastState(): string;
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
}

interface CastFramework {
  CastContext: { getInstance(): CastContextLike };
  CastState: { CONNECTED: string };
  CastContextEventType: { CAST_STATE_CHANGED: string };
}

interface ChromeCastNamespace {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  Image: new (url: string) => unknown;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    StreamType: { BUFFERED: string };
    MediaInfo: new (contentId: string, contentType: string) => {
      streamType: string;
      metadata: unknown;
    };
    GenericMediaMetadata: new () => { title: string; images: unknown[] };
    LoadRequest: new (media: unknown) => {
      autoplay: boolean;
      currentTime: number;
    };
  };
}

type CastWindow = Window & {
  cast?: { framework?: CastFramework };
  chrome?: { cast?: ChromeCastNamespace };
  __onGCastApiAvailable?: (available: boolean) => void;
};

export interface CastRequestInput {
  url: string;
  title: string;
  poster?: string;
  currentTime?: number;
}

export interface CastRequestPlan {
  contentUrl: string;
  contentType: string;
  title: string;
  images: string[];
  currentTime: number;
}

function clampTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// 只接受电视能直接访问的绝对地址；站内代理地址（相对路径）带着登录 Cookie，电视没有。
export function buildCastRequest(
  input: CastRequestInput
): CastRequestPlan | null {
  const url = (input.url || '').trim();
  if (!/^https?:\/\//.test(url)) return null;
  const poster = (input.poster || '').trim();
  return {
    contentUrl: url,
    contentType: HLS_CONTENT_TYPE,
    title: input.title || '传康播放器',
    images: /^https?:\/\//.test(poster) ? [poster] : [],
    currentTime: clampTime(Number(input.currentTime)),
  };
}

export function castSdkReady(win: CastWindow = window as CastWindow): boolean {
  return Boolean(win.cast?.framework && win.chrome?.cast);
}

function castSdk(win: CastWindow) {
  const framework = win.cast?.framework;
  const cast = win.chrome?.cast;
  if (!framework || !cast) throw new Error('投屏组件还没有加载');
  return { framework, cast };
}

// 按需加载发送端脚本，只在用户点了投屏才下载。失败后可以再试。
export function loadCastSdk(
  win: CastWindow = window as CastWindow
): Promise<boolean> {
  if (castSdkReady(win)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let script: HTMLScriptElement | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      win.clearTimeout(timer);
      if (!ok && script) script.remove();
      resolve(ok && castSdkReady(win));
    };
    const timer = win.setTimeout(() => finish(false), SDK_TIMEOUT_MS);
    win.__onGCastApiAvailable = (available) => finish(available);
    script = win.document.createElement('script');
    script.src = CAST_SDK_URL;
    script.async = true;
    script.onerror = () => finish(false);
    win.document.head.appendChild(script);
  });
}

// 发起投屏：先选设备（需要用户手势），再把 HLS 地址和当前进度交给电视。
// readTime 在选完设备后才调用，这时候的播放进度才准；没有就用 plan 里的时间。
export async function startCast(
  plan: CastRequestPlan,
  win: CastWindow = window as CastWindow,
  readTime?: () => number
): Promise<{ device: string }> {
  const { framework, cast } = castSdk(win);
  const context = framework.CastContext.getInstance();
  context.setOptions({
    receiverApplicationId: cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  let session = context.getCurrentSession();
  if (!session) {
    await context.requestSession();
    session = context.getCurrentSession();
  }
  if (!session) throw new Error('没有选中设备');

  const mediaInfo = new cast.media.MediaInfo(plan.contentUrl, plan.contentType);
  mediaInfo.streamType = cast.media.StreamType.BUFFERED;
  const metadata = new cast.media.GenericMediaMetadata();
  metadata.title = plan.title;
  metadata.images = plan.images.map((url) => new cast.Image(url));
  mediaInfo.metadata = metadata;

  const request = new cast.media.LoadRequest(mediaInfo);
  request.autoplay = true;
  request.currentTime = readTime ? clampTime(readTime()) : plan.currentTime;
  await session.loadMedia(request);
  return { device: session.getCastDevice?.()?.friendlyName || '电视' };
}

export function stopCast(win: CastWindow = window as CastWindow): void {
  if (!castSdkReady(win)) return;
  const { framework } = castSdk(win);
  framework.CastContext.getInstance().getCurrentSession()?.endSession(true);
}

// 监听投屏状态变化，返回取消订阅的函数。SDK 还没加载时返回空操作。
export function observeCast(
  onChange: (state: { connected: boolean; device: string }) => void,
  win: CastWindow = window as CastWindow
): () => void {
  if (!castSdkReady(win)) return () => undefined;
  const { framework } = castSdk(win);
  const context = framework.CastContext.getInstance();
  const handler = () => {
    const connected = context.getCastState() === framework.CastState.CONNECTED;
    const session = context.getCurrentSession();
    onChange({
      connected,
      device: connected
        ? session?.getCastDevice?.()?.friendlyName || '电视'
        : '',
    });
  };
  context.addEventListener(
    framework.CastContextEventType.CAST_STATE_CHANGED,
    handler
  );
  return () =>
    context.removeEventListener(
      framework.CastContextEventType.CAST_STATE_CHANGED,
      handler
    );
}
