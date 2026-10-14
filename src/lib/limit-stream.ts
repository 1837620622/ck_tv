// 把一条响应体流限制在 maxBytes 以内，并且两块数据之间不能空等超过 idleMs。
// 超限时报错中断；空等超时就取消上游，读取随之结束。
// 图片代理用它代替「整个响应体的总超时」：慢但持续出数据的图片能读完，卡住的连接会被切断。
export function limitStream(
  source: ReadableStream<Uint8Array>,
  options: { maxBytes: number; idleMs: number }
): ReadableStream<Uint8Array> {
  const { maxBytes, idleMs } = options;
  const reader = source.getReader();
  let total = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      try {
        idle = setTimeout(() => {
          reader.cancel().catch(() => undefined);
        }, idleMs);
        const { done, value } = await reader.read();
        clearTimeout(idle);
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error('响应体超过大小上限'));
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        clearTimeout(idle);
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
