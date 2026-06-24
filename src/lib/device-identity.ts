/**
 * Canonical device identity (task 0863).
 *
 * Historically one physical device generated FOUR uncorrelated UUIDs — one
 * each for the sync engine, the push-token registration, the backup manifest,
 * and (separately) the server `client_devices` row. They never matched, so
 * per-device features (mute, encryption ACLs, per-device backup status) would
 * have targeted different "devices."
 *
 * This module is the single source of truth: `getDeviceId()` lazily generates
 * and persists ONE opaque UUID in secure storage and every client-side store
 * reads from it.
 *
 * ── Why the SYNC id is the canonical anchor (the re-upload-safety decision) ──
 *
 * The dominant data-safety risk in unifying these ids is a backup re-upload
 * storm: if the value that keys a device's *server-side* backup/dedup state
 * changes, the device's existing camera-roll backup can look like a NEW device
 * and re-upload the entire library. So the canonical id must be whichever id
 * already keys server-side state — never a freshly minted one for an existing
 * install.
 *
 * Audited (2026-06-25), the four sources key the server as follows:
 *   - sync-client `bb_sync_device_id` → CRDT op origin AND the
 *     `X-Beebeeb-Device-Id` header on `photoBackupClearAssociation`, which the
 *     server uses to scope its `photo_backup_state` PhotoKit-dedup table
 *     (`(user_id, device_id, local_identifier)`). THIS is the only id that
 *     keys server-side per-device backup state. ← the anchor.
 *   - BackupService `beebeeb_device_id` → WRITE-ONLY manifest metadata
 *     (`.device.json`). It is never read back; backup folders are keyed by
 *     `device_name` and uploaded-state is keyed by file id. Changing it is
 *     inert server-side.
 *   - push `beebeeb_push_device_id` → a local pseudo-id used only as the
 *     push-token register/unregister key. Not backup-related.
 *   - device-registration `beebeeb_registered_device_id` → the
 *     SERVER-AUTHORITATIVE `client_devices.id`, minted by the server on an
 *     UPSERT over `(user_id, hostname, platform)`. The client cannot choose it.
 *
 * Therefore: adopt the existing `bb_sync_device_id` as canonical when present
 * (so the PhotoKit-dedup anchor and all CRDT op origins are unchanged → no
 * re-upload), else fall back to the backup id, else mint a fresh UUID. The
 * server `client_devices.id` remains server-authoritative and is NOT replaced;
 * the canonical id is threaded into push registration as the `client_device_id`
 * link instead.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// ── Storage keys ────────────────────────────────────────────────────────────

/** Canonical device-identity key. Reuses the sync engine's existing key so an
 *  already-synced device keeps the exact same value (no PhotoKit-dedup churn,
 *  no CRDT op-origin discontinuity). For a fresh install this key is minted
 *  here and the sync engine reads it back. */
export const DEVICE_ID_KEY = 'bb_sync_device_id';

/** Legacy per-store keys we migrate FROM (kept for one-time reconciliation). */
const LEGACY_BACKUP_DEVICE_ID_KEY = 'beebeeb_device_id';

// ── Secure storage abstraction (SecureStore on native, localStorage on web) ──

const storage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // SecureStore can fail on devices without a secure enclave — silently
      // skip; getDeviceId still returns the in-memory value for this session.
    }
  },
};

// ── UUID ─────────────────────────────────────────────────────────────────────

/** UUID v4. The device id is an opaque identifier — no crypto-grade entropy is
 *  required (the account auth guards access). Prefer crypto.randomUUID when the
 *  RN runtime provides it, else fall back to a Math.random template. */
function uuid(): string {
  const g = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Canonical accessor ───────────────────────────────────────────────────────

// Coalesce concurrent first-run callers so two awaits can't each mint a UUID.
let _inFlight: Promise<string> | null = null;

async function resolveCanonicalId(): Promise<string> {
  // 1. Already canonical → return as-is. This is the steady-state path.
  const existing = await storage.get(DEVICE_ID_KEY);
  if (existing) return existing;

  // 2. No canonical id yet. Adopt an existing legacy id so server-side state
  //    that may already be keyed by it is preserved (re-upload-safe). The sync
  //    id is the canonical key itself (handled in step 1); the next-safest
  //    carry-forward is the backup manifest id — on an install old enough to
  //    have one but no sync id, no PhotoKit dedup exists yet, so adopting it is
  //    inert but keeps the manifest's device_id stable across the upgrade.
  const legacyBackupId = await storage.get(LEGACY_BACKUP_DEVICE_ID_KEY);
  if (legacyBackupId) {
    await storage.set(DEVICE_ID_KEY, legacyBackupId);
    return legacyBackupId;
  }

  // 3. Fresh install — mint one canonical UUID.
  const id = uuid();
  await storage.set(DEVICE_ID_KEY, id);
  return id;
}

/**
 * The canonical, stable device id for this install. Lazily generated and
 * persisted in secure storage on first call; identical for the lifetime of the
 * install (until the OS clears the keychain / the app is reinstalled).
 *
 * Used by: the sync engine (CRDT op origin), the `X-Beebeeb-Device-Id` header
 * (PhotoKit dedup), the backup manifest `device_id`, and the push-token link.
 */
export async function getDeviceId(): Promise<string> {
  if (_inFlight) return _inFlight;
  _inFlight = resolveCanonicalId();
  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}
