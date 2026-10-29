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
 * Reviewed in house (2026-06-25), the four sources key the server as follows:
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

/**
 * One read of a secure-storage key. Task 1667 round 13 (review item 1): a
 * read that FAILED is not "no value". expo-secure-store answers `null` only
 * for `errSecItemNotFound`; any other keychain status throws, most often
 * `errSecInteractionNotAllowed` while the device is locked (the item is
 * stored WHEN_UNLOCKED, expo's default). Before, both read as `null`, and
 * `getDeviceId()` minted a fresh UUID over an id that existed but could not
 * be read.
 */
type StorageRead = { ok: true; value: string | null } | { ok: false };

const storage = {
  async get(key: string): Promise<StorageRead> {
    if (Platform.OS === 'web') {
      return { ok: true, value: typeof window === 'undefined' ? null : window.localStorage.getItem(key) };
    }
    try {
      return { ok: true, value: await SecureStore.getItemAsync(key) };
    } catch {
      return { ok: false };
    }
  },
  /** True only when the write succeeded AND reading it back gives `value`. */
  async setDurably(key: string, value: string): Promise<boolean> {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return false;
      window.localStorage.setItem(key, value);
      return window.localStorage.getItem(key) === value;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // SecureStore can fail on devices without a secure enclave, or while
      // the device is locked. The caller decides what an unpersisted id may
      // be used for (never the native backup handoff).
      return false;
    }
    const back = await storage.get(key);
    return back.ok && back.value === value;
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

/**
 * Task 1667 round 13 (review item 1): the keychain could not be READ (locked
 * device, keychain error). The id may exist; nothing may be minted in its
 * place. Every caller of `getDeviceId()` handles it (see the sweep in
 * mobile#182 round 13): best-effort callers send no id, the native backup
 * handoff sends nothing.
 */
export class DeviceIdUnavailableError extends Error {
  constructor() {
    super('device id unavailable: the secure storage read failed');
    this.name = 'DeviceIdUnavailableError';
  }
}

/** Where the id came from, and whether it is durably stored. */
export interface DeviceIdResolution {
  id: string;
  /** `stored`: the canonical key; `adopted`: the legacy backup key (read, so
   *  durable even when copying it to the canonical key failed); `minted`: a
   *  fresh UUID (first run). */
  source: 'stored' | 'adopted' | 'minted';
  /** True when the id was read from secure storage or written there and read
   *  back. A minted id whose write failed is false: it lives in memory only. */
  persisted: boolean;
}

// Coalesce concurrent first-run callers so two awaits can't each mint a UUID.
let _inFlight: Promise<DeviceIdResolution> | null = null;
// A minted id whose write failed: reused (and its write retried) for the rest
// of this session, so the session never sees two different ids.
let _unpersistedMintedId: string | null = null;

async function resolveCanonicalId(): Promise<DeviceIdResolution> {
  // 1. Already canonical → return as-is. This is the steady-state path.
  const existing = await storage.get(DEVICE_ID_KEY);
  if (!existing.ok) throw new DeviceIdUnavailableError();
  if (existing.value) {
    _unpersistedMintedId = null;
    return { id: existing.value, source: 'stored', persisted: true };
  }

  // 2. No canonical id yet. Adopt an existing legacy id so server-side state
  //    that may already be keyed by it is preserved (re-upload-safe). The sync
  //    id is the canonical key itself (handled in step 1); the next-safest
  //    carry-forward is the backup manifest id — on an install old enough to
  //    have one but no sync id, no PhotoKit dedup exists yet, so adopting it is
  //    inert but keeps the manifest's device_id stable across the upgrade.
  //    Round 13: a failed legacy read is not "none" either.
  const legacyBackupId = await storage.get(LEGACY_BACKUP_DEVICE_ID_KEY);
  if (!legacyBackupId.ok) throw new DeviceIdUnavailableError();
  if (legacyBackupId.value) {
    await storage.setDurably(DEVICE_ID_KEY, legacyBackupId.value);
    // Durable either way: it was READ from the legacy key, which native
    // also reads (BackupDeviceId.swift).
    return { id: legacyBackupId.value, source: 'adopted', persisted: true };
  }

  // 3. Fresh install (both keys READ as absent) — mint one canonical UUID.
  const id = _unpersistedMintedId ?? uuid();
  const persisted = await storage.setDurably(DEVICE_ID_KEY, id);
  _unpersistedMintedId = persisted ? null : id;
  return { id, source: 'minted', persisted };
}

/**
 * Task 1667 round 13 (review item 1): the canonical id with how it was
 * obtained. Throws `DeviceIdUnavailableError` when secure storage could not
 * be read; mints (and persists) a UUID only when both keys were read as
 * absent.
 */
export async function resolveDeviceId(): Promise<DeviceIdResolution> {
  if (_inFlight) return _inFlight;
  _inFlight = resolveCanonicalId();
  try {
    return await _inFlight;
  } finally {
    _inFlight = null;
  }
}

/**
 * The canonical, stable device id for this install. Lazily generated and
 * persisted in secure storage on first call; identical for the lifetime of the
 * install (until the OS clears the keychain / the app is reinstalled).
 *
 * Used by: the sync engine (CRDT op origin), the `X-Beebeeb-Device-Id` header
 * (PhotoKit dedup), the backup manifest `device_id`, and the push-token link.
 *
 * Round 13: rejects with `DeviceIdUnavailableError` when the keychain cannot
 * be read (it never mints over an id it could not read).
 */
export async function getDeviceId(): Promise<string> {
  return (await resolveDeviceId()).id;
}

/**
 * Round 13 (review item 1): the id only when it is durable (read from secure
 * storage, or minted and persisted). null when the read failed or a minted
 * id could not be stored. The native backup handoff uses only this.
 */
export async function getDurableDeviceId(): Promise<string | null> {
  try {
    const r = await resolveDeviceId();
    return r.persisted && r.id ? r.id : null;
  } catch {
    return null;
  }
}
