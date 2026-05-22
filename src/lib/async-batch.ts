export async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  worker: (item: T, index: number) => Promise<R>,
  yieldBetweenBatches: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<R[]> {
  const size = Math.max(1, Math.floor(batchSize));
  const results = new Array<R>(items.length);

  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    await Promise.all(batch.map(async (item, offset) => {
      const index = start + offset;
      results[index] = await worker(item, index);
    }));
    if (start + size < items.length) {
      await yieldBetweenBatches();
    }
  }

  return results;
}
