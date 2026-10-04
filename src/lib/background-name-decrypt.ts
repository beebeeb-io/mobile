import type { BatchNameItem, BatchNameResult } from '../../modules/beebeeb-crypto/src/BeebeebCrypto';

/** Background metadata work yields before every bounded native batch. */
export async function decryptNamesInBackground(
  items: readonly BatchNameItem[],
  decryptBatch: (batch: BatchNameItem[]) => Promise<BatchNameResult[]>,
  apply: (item: BatchNameItem, result: BatchNameResult) => void,
  cancelled: () => boolean,
  yieldToBrowsing: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 50)),
): Promise<number> {
  let applied = 0;
  for (let start = 0; start < items.length; start += 12) {
    await yieldToBrowsing();
    if (cancelled()) break;
    const batch = items.slice(start, start + 12);
    const results = await decryptBatch(batch);
    if (cancelled()) break;
    results.forEach((result, index) => {
      if (!result || result.error || !result.name) return;
      const item = batch[index];
      if (!item) return;
      apply(item, result);
      applied++;
    });
  }
  return applied;
}
