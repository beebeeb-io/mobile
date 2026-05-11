/**
 * PhotoBackupCheckpoint — persist the most-recently-backed-up asset's
 * creation timestamp so the runner can skip already-processed assets
 * across app kills and foreground/background cycles.
 *
 * Stored as a Unix timestamp in **milliseconds**. Expo MediaLibrary accepts
 * numeric `createdAfter` values in milliseconds. Null means "never backed up
 * — process everything".
 */

import { Platform } from 'react-native';

let SecureStore: {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
} | null = null;

try {
  SecureStore = require('expo-secure-store');
} catch {
  // expo-secure-store unavailable (web / tests)
}

const CHECKPOINT_KEY = 'bb_photo_backup_last_ts';
const LAST_SESSION_KEY = 'bb_photo_backup_last_session_at';

async function storeGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  }
  return SecureStore?.getItemAsync(key) ?? null;
}

async function storeSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    return;
  }
  await SecureStore?.setItemAsync(key, value);
}

/**
 * Read the Unix timestamp (milliseconds) of the last successfully backed-up
 * asset. Returns null if no backup has ever completed.
 */
export async function readLastBackedUpTimestamp(): Promise<number | null> {
  const raw = await storeGet(CHECKPOINT_KEY);
  if (!raw) return null;
  const n = parseFloat(raw);
  if (!isFinite(n)) return null;
  // Older builds documented this as seconds. Normalize those values to Expo's
  // millisecond API shape without disturbing existing millisecond checkpoints.
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

/**
 * Write the Unix timestamp (milliseconds) of an asset that was just backed up.
 * Only writes if `ts` is strictly greater than the stored value, so
 * out-of-order calls (unlikely but possible) don't regress the checkpoint.
 */
export async function writeLastBackedUpTimestamp(ts: number): Promise<void> {
  const current = await readLastBackedUpTimestamp();
  if (current !== null && ts <= current) return;
  await storeSet(CHECKPOINT_KEY, String(ts));
}

/**
 * Save the ISO timestamp of when the last backup session completed.
 * Used by the Settings screen to show "Last: 2 hours ago".
 */
export async function writeLastSessionAt(iso: string): Promise<void> {
  await storeSet(LAST_SESSION_KEY, iso);
}

export async function readLastSessionAt(): Promise<string | null> {
  return storeGet(LAST_SESSION_KEY);
}
