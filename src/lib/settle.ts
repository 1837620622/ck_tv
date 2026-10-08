// 搜索要同时问很多采集站。先把已经返回的结果交出去，慢站在后台收齐再写入边缘缓存。

export async function settleWithin<T>(
  tasks: Promise<T>[],
  ms: number,
  empty: T
): Promise<{ values: T[]; complete: boolean; done: Promise<T[]> }> {
  const values = tasks.map(() => empty);
  const done = Promise.all(
    tasks.map(async (task, index) => {
      try {
        values[index] = await task;
      } catch {
        values[index] = empty;
      }
      return values[index];
    })
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const complete = await Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (complete) await done;
  return { values, complete, done };
}
