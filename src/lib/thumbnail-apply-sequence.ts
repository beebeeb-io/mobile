/**
 * Task 1962 round 5 (review finding P2.1) — the ordering of the thumbnail
 * "Apply quality" sequence.
 *
 * Round 4 checked the account epoch only AFTER `seedLocalIdentifierMap`, which
 * always writes `local-id-map.json` and the native identifier map. A forced
 * sign-out landing during the preceding `getRemoteToLocalMap()` await therefore
 * still wrote the outgoing account's local identifiers into the next session.
 *
 * This module owns the sequence so the epoch is checked immediately before the
 * first write (the seed) and again immediately before the enqueue, with no
 * await between either check and its call. The screen passes its real deps;
 * the test drives the epoch advancing at each await with fakes.
 */

export type ThumbnailApplySequenceDeps = {
  /** The epoch captured by the screen before its first await. */
  capturedEpoch: number;
  getRemoteToLocalMap: () => Promise<Map<string, string>>;
  seedLocalIdentifierMap: (map: Record<string, string>) => Promise<void>;
  enqueue: (fileIds: string[], qualityPreset: string) => Promise<void>;
  isCurrentEpoch: (epoch: number) => boolean;
};

export type ThumbnailApplyOutcome = 'applied' | 'epoch-advanced';

export async function seedAndEnqueueThumbnailApply(
  deps: ThumbnailApplySequenceDeps,
  fileIds: string[],
  qualityPreset: string,
): Promise<ThumbnailApplyOutcome> {
  const localMap = await deps.getRemoteToLocalMap();
  // Round 5: the check now sits BEFORE the first write. On 92f084aa the seed
  // ran first, so a sign-out during the await above still wrote
  // local-id-map.json + the native map for the outgoing account.
  if (!deps.isCurrentEpoch(deps.capturedEpoch)) return 'epoch-advanced';
  await deps.seedLocalIdentifierMap(Object.fromEntries(localMap));
  if (!deps.isCurrentEpoch(deps.capturedEpoch)) return 'epoch-advanced';
  await deps.enqueue(fileIds, qualityPreset);
  return 'applied';
}
