/** Run `work` over `items` with at most `n` in flight. Results keep the input order. */
export async function runPool<T, R>(items: T[], n: number, work: (item: T, worker: number, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async (_, worker) => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], worker, i);
    }
  });
  await Promise.all(lanes);
  return results;
}
