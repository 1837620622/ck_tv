// 带超时的 fetch。不用 AbortSignal.timeout：iOS 15 及更早的 Safari 没有它，会直接抛错。
// 超时只管到响应头回来为止，正文由调用方读取。
export async function fetchWithin(
  input: string,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
