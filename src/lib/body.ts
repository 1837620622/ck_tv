// 读取 JSON 请求体，边读边计数，超过上限就停止读取。
// 不设上限的话，单个请求就能把任意大小的请求体整个读进内存；
// Docker 里跑的是 Node 运行时，没有默认的请求体大小限制。

// 写接口的请求体都是几 KB 的 JSON，64KB 已经很宽松
export const DEFAULT_JSON_BODY_BYTES = 64 * 1024;

export type JsonBodyResult =
  | { ok: true; data: unknown }
  | { ok: false; status: 400 | 413; error: string };

const TOO_LARGE: JsonBodyResult = {
  ok: false,
  status: 413,
  error: '请求体过大',
};

export async function readJsonBody(
  request: Request,
  maxBytes: number
): Promise<JsonBodyResult> {
  // 声明了长度且超限的，连读都不读
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) return TOO_LARGE;

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      // 客户端中途断开或读取出错，和 JSON 格式错误一样按 400 处理，不能抛成 500
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return { ok: false, status: 400, error: '请求格式不正确' };
      }
      const { done, value } = chunk;
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400, error: '请求格式不正确' };
  }
}
