/**
 * Photo preview settings — the compare view's sample files.
 *
 * `encodePhotoPreviewSample` and `originalPhotoForCompare` make PLAINTEXT
 * copies of a library photo under `Caches/beebeeb-previews-v1/samples/`. Both
 * spend a long time in native code before the write: the source comes from
 * PhotoKit with `isNetworkAccessAllowed`, so an iCloud download can hold the
 * encode for many seconds and land its write at any moment — including after
 * a sign-out's purge swept that directory. Like every other plaintext writer
 * (`photo-preview-cache.ts`, `photo-cache.ts`, `raw-extract.ts`), the whole
 * async span that ends in the write therefore holds a lease from the
 * plaintext gate:
 *
 *  - the sign-out purge closes the gate first, so no new sample encode starts;
 *  - it then waits for held leases to drain before it sweeps, so an encode
 *    already running finishes (and is swept) rather than racing the sweep;
 *  - an encode that settles after the bound finds its lease invalid and
 *    deletes its own file instead of leaving it behind.
 *
 * Do not call the native functions from anywhere else: the guard in
 * `photo-preview-native.guard.test.ts` fails if a sample write is reachable
 * outside a lease.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { encodePhotoPreviewSample, originalPhotoForCompare } from '../../modules/beebeeb-crypto';
import {
  PlaintextGateClosedError,
  withPlaintextLease,
  type PlaintextLease,
} from './plaintext-gate';

export type CompareSample = { path: string; bytes: number; width: number; height: number };
export type CompareOriginal = { path: string; width: number; height: number; originalBytes?: number };
export type CompareSampleFormat = 'heic' | 'jpeg';

const SAMPLES_DIR_MARK = '/beebeeb-previews-v1/samples/';

/** Only ever deletes inside the Caches samples folder — never an arbitrary path. */
async function discardSample(path: string): Promise<void> {
  if (!path.includes(SAMPLES_DIR_MARK)) return;
  const uri = path.startsWith('file://') ? path : `file://${path}`;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/**
 * Run one native sample encode under `lease`: refuse before it when the gate is
 * closed, and — when a purge closed the gate while the native encode was
 * running — delete what it wrote and throw, so nothing outlives the purge.
 */
async function encodeUnderLease<T extends { path: string }>(
  lease: PlaintextLease,
  encode: () => Promise<T>,
): Promise<T> {
  lease.assertValid();
  const result = await encode();
  if (!lease.valid) {
    await discardSample(result.path);
    throw new PlaintextGateClosedError(lease.label);
  }
  return result;
}

/** A preview sample (plaintext, Caches only) for the compare view. */
export function encodePreviewSample(
  localIdentifier: string,
  format: CompareSampleFormat,
  px: number,
): Promise<CompareSample> {
  return withPlaintextLease('photo compare sample', (lease) =>
    encodeUnderLease(lease, () => encodePhotoPreviewSample(localIdentifier, format, px)),
  );
}

/** The downsampled original (plaintext, Caches only) the previews are judged against. */
export function originalForCompare(localIdentifier: string, maxPx: number): Promise<CompareOriginal> {
  return withPlaintextLease('photo compare original', (lease) =>
    encodeUnderLease(lease, () => originalPhotoForCompare(localIdentifier, maxPx)),
  );
}
