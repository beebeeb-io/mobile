/**
 * BackupService — manages the backup folder hierarchy and the per-device
 * `.device.json` manifest.
 *
 * The folder layout (see spec 010):
 *
 *   /Backups/
 *     {Device Name}/
 *       .device.json
 *       Camera Roll/
 *       Contacts/
 *       Calendar/
 *
 * Backups are just regular encrypted files — the server has no special
 * backup endpoints. This module only handles folder bookkeeping and the
 * manifest; the upload/scan workers live in separate modules.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

let Device: { deviceName: string | null; modelName: string | null; osName: string | null; osVersion: string | null } = {
  deviceName: null, modelName: null, osName: null, osVersion: null,
};
try {
  Device = require('expo-device');
} catch {
  // expo-device not available in Expo Go — use defaults
}
import {
  createFolder,
  deleteFile,
  downloadFile,
  listAllFiles,
  findFile,
  moveFile,
  renameFile,
  trashFiles,
  getFileIndex,
  type FileEntry,
} from '../lib/api';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { encryptedMetadataToJson, encryptedMetadataPayloadToBytes, fileMetadataPlaintext } from '../lib/encrypted-metadata';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { guessMimeType } from '../lib/media';
// 0817 — reconcile derived state against /files/index (server truth).
import { getAllUploadedRemoteIds, resetUploadedState } from './BackupDatabase';
import { offlineManager } from '../lib/offline-manager';
import {
  pruneThumbnailsForRemoteFiles,
  invalidateCachedThumbnails,
  invalidateNativeThumbnailCache,
} from '../lib/thumbnail-cache';
import { loadNameCache, pruneNameCache } from '../lib/name-cache';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BackupCategory = 'camera_roll' | 'contacts' | 'calendar';

export interface BackupCategoryState {
  enabled: boolean;
  last_sync: string | null;
  items_synced: number;
  // Camera roll specific
  include_videos?: boolean;
  wifi_only?: boolean;
  background_enabled?: boolean;
  // Contacts specific
  contact_count?: number;
  // Calendar specific
  calendar_count?: number;
  // Files/folders moved from pre-category backup layouts.
  legacy_items_migrated?: number;
}

export interface DeviceManifest {
  version: number;
  device_id: string;
  device_name: string;
  device_model: string;
  os_version: string;
  app_version: string;
  created_at: string;
  deletion_behavior?: 'keep' | 'trash';
  keep_vault_unlocked?: boolean;
  backups: {
    camera_roll: BackupCategoryState;
    contacts: BackupCategoryState;
    calendar: BackupCategoryState;
  };
}

export interface BackupProgress {
  category: BackupCategory;
  state: 'idle' | 'scanning' | 'uploading' | 'paused' | 'complete' | 'error';
  itemsSynced: number;
  itemsTotal: number;
  bytesSynced: number;
  bytesTotal: number;
  currentFile?: string;
  avgSpeedBps: number;
  estimatedSecondsRemaining?: number;
  pauseReason?: 'no_wifi' | 'low_battery' | 'no_network' | 'server_error';
  lastSyncAt?: string;
  error?: string;
}

/** Encryption functions needed by the backup folder machinery. */
export interface BackupEncryption {
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  decryptChunkFn: (fileId: string, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<Uint8Array>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
  decryptMetadataFn: (fileId: string, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<string>;
}

// Module-level encryption handle set by callers via setBackupEncryption().
// This avoids threading encryption through every internal helper while still
// ensuring all folder/file operations go through the crypto context.
let _encryption: BackupEncryption | null = null;

/**
 * Register the crypto functions that BackupService uses to encrypt/decrypt
 * folder and file names. Must be called once after the vault is unlocked and
 * before any ensureBackupFolders / manifest operations.
 */
export function setBackupEncryption(enc: BackupEncryption | null): void {
  _encryption = enc;
}

function requireEncryption(): BackupEncryption {
  if (!_encryption) {
    throw new Error('[BackupService] Encryption not configured — call setBackupEncryption() after vault unlock');
  }
  return _encryption;
}

function isEncryptionUnavailableError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Encryption not configured');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = 'beebeeb_device_id';
const FOLDER_CACHE_KEY = 'beebeeb_backup_folders';
const MANIFEST_FILENAME = '.device.json';
const MANIFEST_VERSION = 1;
const APP_VERSION = '1.0.0';
const FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;
const NONCE_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const BROKEN_MANIFEST_MAX_BYTES = 8 * 1024;

const ROOT_FOLDER_NAME = 'Backups';

const CATEGORY_FOLDERS: Record<BackupCategory, string> = {
  camera_roll: 'Camera Roll',
  contacts: 'Contacts',
  calendar: 'Calendar',
};

type NameDecryptResult = {
  name: string;
  mimeType: string | null;
  canonical: boolean;
};

// ---------------------------------------------------------------------------
// SecureStore helpers (web fallback to localStorage so dev preview works)
// ---------------------------------------------------------------------------

async function storeGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  }
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function storeSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    return;
  }
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // SecureStore fails in background/locked state — non-critical for backup state
  }
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/** UUID v4 generator. The device ID is an opaque identifier — no crypto-grade
 *  entropy needed; the user's account auth is what guards access. */
function generateUuid(): string {
  const g = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function getOrCreateDeviceId(): Promise<string> {
  const existing = await storeGet(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = generateUuid();
  await storeSet(DEVICE_ID_KEY, id);
  return id;
}

interface DeviceInfo {
  device_id: string;
  device_name: string;
  device_model: string;
  os_version: string;
  app_version: string;
}

async function getDeviceInfo(): Promise<DeviceInfo> {
  return {
    device_id: await getOrCreateDeviceId(),
    device_name: Device.deviceName ?? 'Unknown Device',
    device_model: Device.modelName ?? 'Unknown Model',
    os_version: `${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`.trim(),
    app_version: APP_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Folder cache
// ---------------------------------------------------------------------------

interface FolderCache {
  rootId?: string;
  deviceId?: string;
  categoryIds?: Partial<Record<BackupCategory, string>>;
  legacyMigration?: Partial<Record<BackupCategory, number>> & { completedAt?: string };
}

async function readFolderCache(): Promise<FolderCache> {
  const raw = await storeGet(FOLDER_CACHE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FolderCache;
  } catch {
    return {};
  }
}

async function writeFolderCache(cache: FolderCache): Promise<void> {
  await storeSet(FOLDER_CACHE_KEY, JSON.stringify(cache));
}

function mergeLegacyMigration(
  manifest: DeviceManifest,
  migration?: FolderCache['legacyMigration'],
): DeviceManifest {
  if (!migration) return manifest;
  return {
    ...manifest,
    backups: {
      camera_roll: {
        ...manifest.backups.camera_roll,
        legacy_items_migrated: migration.camera_roll ?? manifest.backups.camera_roll.legacy_items_migrated,
      },
      contacts: {
        ...manifest.backups.contacts,
        legacy_items_migrated: migration.contacts ?? manifest.backups.contacts.legacy_items_migrated,
      },
      calendar: {
        ...manifest.backups.calendar,
        legacy_items_migrated: migration.calendar ?? manifest.backups.calendar.legacy_items_migrated,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Name encryption helpers
// ---------------------------------------------------------------------------

/** Encrypt a folder name into the canonical JSON envelope the server expects. */
async function encryptFolderName(folderId: string, name: string): Promise<string> {
  const enc = requireEncryption();
  const metadataPlain = fileMetadataPlaintext(name, null);
  const encrypted = await enc.encryptMetadataFn(folderId, metadataPlain);
  return encryptedMetadataToJson(encrypted);
}

/** Encrypt a file name into the canonical JSON envelope the server expects. */
async function encryptFileName(fileId: string, name: string, mimeType?: string): Promise<string> {
  const enc = requireEncryption();
  const metadataPlain = fileMetadataPlaintext(name, mimeType ?? null);
  const encrypted = await enc.encryptMetadataFn(fileId, metadataPlain);
  return encryptedMetadataToJson(encrypted);
}

function parseNameMetadata(plaintext: string): { name: string; mimeType: string | null; canonical: boolean } {
  try {
    const metadata = JSON.parse(plaintext) as { name?: unknown; mime_type?: unknown };
    if (metadata && typeof metadata === 'object' && typeof metadata.name === 'string' && metadata.name.trim()) {
      return {
        name: metadata.name,
        mimeType: typeof metadata.mime_type === 'string' ? metadata.mime_type : null,
        canonical: true,
      };
    }
  } catch {
    // Legacy encrypted payloads were bare filename strings.
  }
  return { name: plaintext, mimeType: null, canonical: false };
}

/**
 * Decrypt a name_encrypted value to its plaintext name. Plaintext legacy
 * values are accepted, but undecryptable encrypted envelopes return null.
 */
async function decryptNameDetails(entry: FileEntry): Promise<NameDecryptResult | null> {
  const enc = requireEncryption();
  const parsed = encryptedMetadataPayloadToBytes(entry.name_encrypted);
  if (!parsed) {
    return {
      name: entry.name_encrypted,
      mimeType: entry.is_folder ? null : guessMimeType(entry.name_encrypted),
      canonical: false,
    };
  }
  try {
    const plaintext = await enc.decryptMetadataFn(entry.id, parsed.nonce, parsed.ciphertext);
    const metadata = parseNameMetadata(plaintext);
    return {
      name: metadata.name,
      mimeType: metadata.mimeType ?? (entry.is_folder ? null : guessMimeType(metadata.name)),
      canonical: metadata.canonical,
    };
  } catch {
    return null;
  }
}

async function decryptName(entry: FileEntry): Promise<string | null> {
  return (await decryptNameDetails(entry))?.name ?? null;
}

async function normalizeBackupNameMetadata(entry: FileEntry, expectedName?: string): Promise<boolean> {
  const details = await decryptNameDetails(entry);
  if (!details) return false;
  const nextName = expectedName ?? details.name;
  if (!nextName) return false;
  const nextMimeType = entry.is_folder ? undefined : (details.mimeType ?? guessMimeType(nextName) ?? undefined);
  if (details.canonical && details.name === nextName && (entry.is_folder || details.mimeType === (nextMimeType ?? null))) {
    return false;
  }

  const nameEncrypted = entry.is_folder
    ? await encryptFolderName(entry.id, nextName)
    : await encryptFileName(entry.id, nextName, nextMimeType);
  await renameFile(entry.id, nameEncrypted);
  return true;
}

// ---------------------------------------------------------------------------
// Folder management
// ---------------------------------------------------------------------------

async function findChildFolder(parentId: string | undefined, name: string): Promise<FileEntry | null> {
  // Early-exit cursor walk: stop at the first matching folder but never miss one
  // past page 1. A capped single page here let ensureFolder create DUPLICATE
  // backup folder trees when a parent had >200 children (task 0755).
  const match = await findFile(parentId, async (f) => f.is_folder && (await decryptName(f)) === name);
  return match ?? null;
}

// In-flight find-or-create coalescing (0811). The find-then-create in
// ensureFolder is not atomic: concurrent callers for the same (parent, name)
// could each find nothing and then each create, producing duplicate folders.
// The founder hit exactly this — three backup categories enabling at once each
// created a "Backups" root (6 duplicates accrued via repeated runs). Keying by
// parent + name and sharing ONE promise makes find-or-create effectively atomic
// within the process. The entry is cleared on settle so a later call re-runs
// (and so re-validates / self-heals if the folder was deleted out-of-band).
const _ensureFolderInFlight = new Map<string, Promise<string>>();

async function ensureFolder(parentId: string | undefined, name: string): Promise<string> {
  const key = `${parentId ?? 'root'}/${name}`;
  const pending = _ensureFolderInFlight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<string> => {
    const existing = await findChildFolder(parentId, name);
    if (existing) return existing.id;
    const folderId = await generateFileId();
    const nameEncrypted = await encryptFolderName(folderId, name);
    const created = await createFolder(nameEncrypted, parentId, folderId);
    return created.id;
  })();

  _ensureFolderInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    _ensureFolderInFlight.delete(key);
  }
}

async function moveLegacyItem(item: FileEntry, parentId: string, newPlaintextName?: string): Promise<boolean> {
  try {
    await moveFile(item.id, parentId);
    if (newPlaintextName) {
      const decrypted = await decryptName(item);
      if (decrypted !== newPlaintextName) {
        const nameEncrypted = await encryptFileName(item.id, newPlaintextName);
        await renameFile(item.id, nameEncrypted);
      }
    }
    return true;
  } catch (err) {
    console.warn('[BackupService] legacy backup migration failed:', err);
    return false;
  }
}

async function migrateLegacyRootBackups(
  cache: FolderCache,
  categoryIds: Record<BackupCategory, string>,
): Promise<FolderCache> {
  if (cache.legacyMigration?.completedAt) return cache;

  const summary: Record<BackupCategory, number> = {
    camera_roll: 0,
    contacts: 0,
    calendar: 0,
  };

  let rootChildren: FileEntry[];
  try {
    rootChildren = await listAllFiles(undefined);
  } catch (err) {
    console.warn('[BackupService] could not inspect root for legacy backups:', err);
    return cache;
  }

  // Decrypt names for comparison — legacy items may have plaintext or encrypted names
  for (const f of rootChildren) {
    const decrypted = await decryptName(f);
    if (f.is_folder && decrypted === 'Photos') {
      if (await moveLegacyItem(f, categoryIds.camera_roll, 'Photos (legacy)')) {
        summary.camera_roll += 1;
      }
    }
    if (!f.is_folder && decrypted === 'contacts.vcf') {
      if (await moveLegacyItem(f, categoryIds.contacts, 'contacts.legacy.vcf')) {
        summary.contacts += 1;
      }
    }
    if (!f.is_folder && decrypted === 'calendar.ics') {
      if (await moveLegacyItem(f, categoryIds.calendar, 'calendar.legacy.ics')) {
        summary.calendar += 1;
      }
    }
  }

  return {
    ...cache,
    legacyMigration: {
      completedAt: new Date().toISOString(),
      camera_roll: summary.camera_roll,
      contacts: summary.contacts,
      calendar: summary.calendar,
    },
  };
}

async function selfHealKnownBackupMetadata(
  rootId: string,
  deviceFolderId: string,
  categoryIds: Record<BackupCategory, string>,
  deviceName: string,
): Promise<void> {
  if (!_encryption) return;
  let healed = 0;

  const normalize = async (entry: FileEntry | undefined, expectedName?: string): Promise<void> => {
    if (!entry) return;
    if (!_encryption) return;
    try {
      if (await normalizeBackupNameMetadata(entry, expectedName)) healed += 1;
    } catch (err) {
      if (isEncryptionUnavailableError(err)) return;
      console.warn('[BackupService] backup metadata self-heal failed:', err);
    }
  };

  try {
    const rootChildren = await listAllFiles(undefined);
    await normalize(rootChildren.find((entry) => entry.id === rootId), ROOT_FOLDER_NAME);
  } catch (err) {
    console.warn('[BackupService] could not self-heal backup root metadata:', err);
  }

  try {
    const backupRootChildren = await listAllFiles(rootId);
    await normalize(backupRootChildren.find((entry) => entry.id === deviceFolderId), deviceName);
  } catch (err) {
    console.warn('[BackupService] could not self-heal backup device metadata:', err);
  }

  try {
    await cleanupBrokenManifestCopies(deviceFolderId);

    const expectedCategoryById = new Map<string, string>(
      (Object.entries(CATEGORY_FOLDERS) as Array<[BackupCategory, string]>)
        .map(([category, name]) => [categoryIds[category], name]),
    );

    const deviceChildren = await listAllFiles(deviceFolderId);
    await Promise.all(deviceChildren.map(async (entry) => {
      const expectedCategoryName = expectedCategoryById.get(entry.id);
      if (expectedCategoryName) {
        await normalize(entry, expectedCategoryName);
        return;
      }

      // Repair small backup-owned files in the device folder, especially
      // old manifest copies. Avoid touching arbitrary large uploads here.
      if (!entry.is_folder && (entry.size_bytes ?? 0) <= 64 * 1024) {
        await normalize(entry);
      }
    }));
  } catch (err) {
    console.warn('[BackupService] could not self-heal backup device children:', err);
  }

  for (const category of ['contacts', 'calendar'] as const) {
    try {
      const children = await listAllFiles(categoryIds[category]);
      await Promise.all(children.map(async (entry) => {
        if (!entry.is_folder) await normalize(entry);
      }));
    } catch (err) {
      console.warn(`[BackupService] could not self-heal ${category} backup metadata:`, err);
    }
  }

  if (healed > 0) {
    console.info(`[BackupService] self-healed ${healed} backup metadata entr${healed === 1 ? 'y' : 'ies'}`);
  }
}

// ---------------------------------------------------------------------------
// 0813 / 0814 — self-heal: merge duplicate backup folders into one
// ---------------------------------------------------------------------------
//
// The pre-0811 find-then-create race duplicated every folder ensureFolder
// creates by fixed name: the "Backups" ROOT (0813 — the founder hit 6), and one
// level deeper the per-DEVICE folders ("Backups/iPhone" ×N) and per-CATEGORY
// folders. 0811 stops new duplicates; this flattens the existing ones by walking
// the Backups subtree (root -> device -> category) and, at each parent, merging
// same-named sibling folders: keep the OLDEST, reparent the others' children
// into it, trash the now-empty duplicates.
//
// Safety — this mutates the real vault, so it is deliberately conservative:
//   - Candidates at a level come only from `listAllFiles(parentId)`, so every
//     group member is a CONFIRMED sibling (same parent). It never merges across
//     parents; `listAllFiles` walks all pages (no missed sibling) and excludes
//     trashed entries (already-merged dups stay merged).
//   - At the vault ROOT only the byte-identical "Backups" name group is touched
//     (never arbitrary user folders). Below the root we are already INSIDE the
//     Backups subtree, so every folder is backup-owned — bounded by construction.
//   - A child is never moved into itself, nor is a member of the same-named group
//     relocated. The survivor sits one level ABOVE the moved children (it is a
//     sibling of their parent), so it can never be in a moved child's subtree —
//     reparenting cannot create a cycle (the "move into self/descendant" hazard
//     is structurally impossible at every level).
//   - A duplicate is trashed ONLY after a fresh listing confirms it is empty; a
//     failed move leaves it untouched for the next (idempotent) run. Trash (not
//     hard-delete) keeps it recoverable.
//   - Idempotent + deterministic: a clean tree is a no-op; survivors are picked
//     by oldest `created_at` (id tie-break for the race's same-millisecond
//     folders), so repeated runs converge.
//   - Depth-bounded to root/device/category — the only levels the race created
//     folders at. We deliberately do NOT descend into category CONTENTS (photos,
//     vCards, ICS were never folder-duplicated and listing them would be costly).
//   - Coalesced: concurrent callers share one in-flight pass; a fully-clean pass
//     sets a session flag so later warm-ups skip the round-trips.

/** Levels of same-named-folder merging below the vault root: device, category. */
const MAX_MERGE_DEPTH = 2;

interface MergeLevelResult {
  /** The deduplicated child folders at this parent (recurse into these). */
  survivors: FileEntry[];
  /** True when every group resolved with no deferred (still-non-empty) dup. */
  fullyClean: boolean;
}

function pickOldest(group: FileEntry[]): FileEntry {
  return group.reduce((best, c) => {
    const tBest = Date.parse(best.created_at);
    const tC = Date.parse(c.created_at);
    if (Number.isNaN(tC)) return best;
    if (Number.isNaN(tBest) || tC < tBest) return c;
    if (tC > tBest) return best;
    return c.id < best.id ? c : best;
  });
}

/**
 * Merge same-named sibling CHILD FOLDERS under `parentId`. When `onlyName` is
 * given, only that one decrypted-name group is considered (used at the vault
 * root to touch ONLY the "Backups" group). Returns the surviving folders so the
 * caller can recurse, plus whether everything resolved cleanly.
 */
async function mergeSameNamedChildFolders(
  parentId: string | undefined,
  onlyName?: string,
): Promise<MergeLevelResult> {
  const children = await listAllFiles(parentId);

  // Group child folders by decrypted name.
  const groups = new Map<string, FileEntry[]>();
  for (const f of children) {
    if (!f.is_folder) continue;
    const name = await decryptName(f);
    if (name == null) continue; // undecryptable — leave it alone
    if (onlyName != null && name !== onlyName) continue;
    const list = groups.get(name) ?? [];
    list.push(f);
    groups.set(name, list);
  }

  const survivors: FileEntry[] = [];
  let fullyClean = true;

  for (const [name, group] of groups) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }

    const survivor = pickOldest(group);
    const groupIds = new Set(group.map((g) => g.id));
    const dups = group.filter((g) => g.id !== survivor.id);

    let moved = 0;
    let trashed = 0;
    let deferred = 0;

    for (const dup of dups) {
      const dupChildren = await listAllFiles(dup.id);
      for (const child of dupChildren) {
        // Never move a folder into itself; never relocate a member of this
        // same-named group. The survivor is a sibling of `dup` (one level above
        // these children), so it cannot be inside a moved child's subtree → no
        // cycle is possible.
        if (child.id === survivor.id || groupIds.has(child.id)) continue;
        try {
          await moveFile(child.id, survivor.id);
          moved += 1;
        } catch (err) {
          console.warn('[BackupService] 0814 merge: could not move child', child.id, err);
        }
      }

      // Trash ONLY once a fresh listing confirms the duplicate is empty.
      const remaining = await listAllFiles(dup.id);
      if (remaining.length === 0) {
        try {
          const result = await trashFiles([dup.id]);
          if (result.trashed.includes(dup.id) || result.already_trashed.includes(dup.id)) {
            trashed += 1;
          } else {
            deferred += 1;
          }
        } catch (err) {
          deferred += 1;
          console.warn('[BackupService] 0814 merge: could not trash empty duplicate', dup.id, err);
        }
      } else {
        deferred += 1;
        console.warn(
          `[BackupService] 0814 merge: "${name}" duplicate ${dup.id} still has ${remaining.length} child(ren) after move — leaving it for the next run`,
        );
      }
    }

    console.info(
      `[BackupService] 0814 merged ${dups.length} "${name}" sibling folder(s) under ${parentId ?? 'root'} into ${survivor.id}: ` +
        `moved ${moved} child(ren), trashed ${trashed}, deferred ${deferred}`,
    );

    if (deferred > 0) fullyClean = false;
    survivors.push(survivor);
  }

  return { survivors, fullyClean };
}

/** Recurse into a Backups subtree folder, merging same-named child folders at
 *  each level down to MAX_MERGE_DEPTH (device, then category). */
async function mergeBackupSubtree(folderId: string, depth: number): Promise<boolean> {
  const level = await mergeSameNamedChildFolders(folderId);
  let clean = level.fullyClean;
  if (depth < MAX_MERGE_DEPTH) {
    for (const survivor of level.survivors) {
      clean = (await mergeBackupSubtree(survivor.id, depth + 1)) && clean;
    }
  }
  return clean;
}

let _backupTreeFlattened = false;
let _flattenInFlight: Promise<void> | null = null;

/** Self-heal entry point: flatten duplicate Backups root/device/category folders
 *  created by the pre-0811 race. Idempotent, coalesced, recoverable. */
async function flattenDuplicateBackupFolders(): Promise<void> {
  if (_backupTreeFlattened) return;
  if (_flattenInFlight) return _flattenInFlight;

  _flattenInFlight = (async () => {
    try {
      // Depth 0 — the vault root: ONLY the "Backups" name group (0813 behaviour).
      const rootLevel = await mergeSameNamedChildFolders(undefined, ROOT_FOLDER_NAME);
      let clean = rootLevel.fullyClean;

      // Recurse into each surviving Backups root (normally exactly one) to merge
      // duplicate device folders, then category folders one level deeper.
      for (const backupsRoot of rootLevel.survivors) {
        clean = (await mergeBackupSubtree(backupsRoot.id, 1)) && clean;
      }

      // Only latch done when the whole subtree resolved with no deferrals; else
      // the next warm-up retries the stragglers (idempotent).
      if (clean) _backupTreeFlattened = true;
    } catch (err) {
      console.warn('[BackupService] 0814 recursive self-heal failed (will retry):', err);
    } finally {
      _flattenInFlight = null;
    }
  })();

  return _flattenInFlight;
}

// ---------------------------------------------------------------------------
// 0817 — reconcile derived state against server truth (/files/index)
// ---------------------------------------------------------------------------
//
// Six derived stores are 100% client-side and never cross-checked against the
// server, so a delete (especially from web — which doesn't cascade a content
// signal through sync) orphans them all: the camera-roll manifest still shows
// "X of Y uploaded", thumbnails/offline copies linger, search keeps stale hits.
// This is the safety net + past-damage repair (the founder deleted "Backups" on
// web; mobile still showed "Uploading 6,398 of 9,464").
//
// Server truth = GET /files/index (whole-vault non-trashed ids, with a HASH
// short-circuit so it's ~free when nothing changed). We diff every reachable
// store's ids against it and demote/remove orphans via the per-store primitives.
// CONSERVATIVE: the backup manifest is RE-QUEUED (pending_upload), never wiped —
// so re-upload is automatic and nothing is lost if the index call was briefly
// wrong.

const RECONCILE_HASH_KEY = 'beebeeb_reconcile_index_hash';
let _reconcileInFlight: Promise<void> | null = null;

/** Reset the persisted backup folder cache so ensureBackupFolders rebuilds the
 *  tree from scratch (used when the whole Backups root is gone). */
async function clearFolderCache(): Promise<void> {
  await writeFolderCache({});
}

/**
 * Reconcile every reachable derived store against `/files/index`. Idempotent,
 * hash-gated (near-free when the vault is unchanged), and coalesced so concurrent
 * callers share one pass. Safe to call on backup warm-up and app foreground.
 */
export async function reconcileDerivedStateAgainstServer(): Promise<void> {
  if (_reconcileInFlight) return _reconcileInFlight;

  _reconcileInFlight = (async () => {
    try {
      const lastHash = (await storeGet(RECONCILE_HASH_KEY)) ?? undefined;
      let resp;
      try {
        resp = await getFileIndex(lastHash);
      } catch (err) {
        // Network/auth blip — leave state as-is and retry next warm-up. NEVER
        // demote on an absent index we couldn't fetch.
        console.warn('[BackupService] reconcile: /files/index fetch failed, skipping', err);
        return;
      }

      // Hash short-circuit: nothing changed since the last reconcile → no-op.
      if (!resp.changed || !resp.files) {
        return;
      }

      const indexIds = new Set(resp.files.map((f) => f.id));

      // --- Backup manifest (camera roll) -------------------------------------
      const cache = await readFolderCache();
      const rootGone = cache.rootId != null && !indexIds.has(cache.rootId);
      const uploadedRemote = await getAllUploadedRemoteIds();
      const backupOrphans = rootGone
        ? [...uploadedRemote]
        : [...uploadedRemote].filter((id) => !indexIds.has(id));

      if (rootGone) {
        // The founder's exact case: the entire Backups tree was deleted
        // server-side. Re-queue ALL uploaded assets (so re-enabling backup
        // re-uploads them) and drop the stale folder cache so the tree rebuilds.
        const requeued = await resetUploadedState();
        await clearFolderCache();
        console.info(`[BackupService] reconcile: Backups root gone — re-queued ${requeued} asset(s), cleared folder cache`);
        // SEAM (0819): contacts/calendar live in native UserDefaults + per-file
        // SHA digests; clearing those (so re-upload isn't SHA-suppressed) is done
        // by the native reset in 0819. Hook it here once that lands.
      } else if (backupOrphans.length > 0) {
        const requeued = await resetUploadedState(backupOrphans);
        console.info(`[BackupService] reconcile: re-queued ${requeued} orphaned backup asset(s)`);
      }

      // --- Offline-pinned copies --------------------------------------------
      const offlineFileOrphans = offlineManager.offlineFileIds().filter((id) => !indexIds.has(id));
      for (const id of offlineFileOrphans) {
        await offlineManager.removeFile(id);
      }
      const offlineFolderOrphans = offlineManager.offlineFolderIds().filter((id) => !indexIds.has(id));
      for (const id of offlineFolderOrphans) {
        await offlineManager.removeFolder(id, []);
      }

      // --- Name cache (0807) -------------------------------------------------
      const nameCache = await loadNameCache();
      const nameOrphans = Object.keys(nameCache).filter((id) => !indexIds.has(id));
      if (nameOrphans.length > 0) await pruneNameCache(nameOrphans);

      // --- Thumbnails --------------------------------------------------------
      // Disk: drop any cached thumbnail whose file isn't in the index.
      await pruneThumbnailsForRemoteFiles(indexIds);
      // Memory (JS) + native FSM/cache: invalidate the union of orphans we found
      // (covers the founder's deleted backup files + any deleted offline/named
      // file) so a warm cache can't keep serving a stale image.
      const orphanUnion = [
        ...new Set([...backupOrphans, ...offlineFileOrphans, ...nameOrphans]),
      ];
      if (orphanUnion.length > 0) {
        await invalidateCachedThumbnails(orphanUnion);
        await invalidateNativeThumbnailCache(orphanUnion);
      }

      // --- Search index ------------------------------------------------------
      // SEAM: the search index is held in the useSearchIndex hook (it owns the
      // HKDF-derived index key + the in-memory blob), which this plain module
      // can't reach. The 0818 dispatcher — wired into React — reconciles it via
      // getIndexedIds() + unindexFile() against this same indexIds set.

      await storeSet(RECONCILE_HASH_KEY, resp.hash);
      console.info(`[BackupService] reconcile complete (index hash ${resp.hash.slice(0, 8)}…, ${indexIds.size} live files)`);
    } catch (err) {
      console.warn('[BackupService] reconcile failed (will retry next warm-up):', err);
    } finally {
      _reconcileInFlight = null;
    }
  })();

  return _reconcileInFlight;
}

/** Ensure `Backups/{deviceName}/{category}/` exists. Returns the device folder
 *  ID and the category folder ID. Each folder is resolved via ensureFolder
 *  (find-or-create, in-flight-coalesced so concurrent callers can't create
 *  duplicates — 0811); the resolved ids are persisted to SecureStore for
 *  diagnostics / future validated reuse. */
export async function ensureBackupFolders(
  category: BackupCategory,
): Promise<{ deviceFolderId: string; categoryFolderId: string }> {
  let cache = await readFolderCache();

  // 0813/0814 — before resolving the tree, flatten any pre-existing duplicate
  // backup folders from the pre-0811 race: the "Backups" ROOT (0813) plus the
  // duplicate device + category folders one/two levels deeper (0814). Running it
  // FIRST means the resolve below targets the single survivor at each level, so
  // we never cache or configure a folder that's about to be emptied/trashed.
  // Best-effort + idempotent.
  await flattenDuplicateBackupFolders();

  // 0817 — reconcile derived state against /files/index (hash-gated, ~free when
  // unchanged). If the Backups root is gone server-side this clears the stale
  // folder cache below + re-queues the manifest, so the resolve rebuilds the
  // tree and the camera-roll count self-corrects. Best-effort.
  await reconcileDerivedStateAgainstServer();

  // NOTE: the previous `cache.rootId`/`deviceId`/`categoryIds` reads here were
  // dead — each was overwritten by the ensureFolder call on the next line. We
  // intentionally keep ensureFolder authoritative (find-or-create) rather than
  // short-circuiting on the cache: a cached id can point at a folder deleted
  // out-of-band, and find-or-create self-heals by recreating it. The race that
  // produced duplicates is closed by ensureFolder's in-flight coalescing above
  // plus sequencing the enables, not by trusting a possibly-stale cache. The
  // cache is still written below for diagnostics / future validated reuse.
  const info = await getDeviceInfo();
  const rootId = await ensureFolder(undefined, ROOT_FOLDER_NAME);
  const deviceFolderId = await ensureFolder(rootId, info.device_name);

  const categoryFolderName = CATEGORY_FOLDERS[category];
  const categoryFolderId = await ensureFolder(deviceFolderId, categoryFolderName);

  const categoryIds: Record<BackupCategory, string> = {
    camera_roll: category === 'camera_roll'
      ? categoryFolderId
      : await ensureFolder(deviceFolderId, CATEGORY_FOLDERS.camera_roll),
    contacts: category === 'contacts'
      ? categoryFolderId
      : await ensureFolder(deviceFolderId, CATEGORY_FOLDERS.contacts),
    calendar: category === 'calendar'
      ? categoryFolderId
      : await ensureFolder(deviceFolderId, CATEGORY_FOLDERS.calendar),
  };

  cache = await migrateLegacyRootBackups(cache, categoryIds);
  await selfHealKnownBackupMetadata(rootId, deviceFolderId, categoryIds, info.device_name);

  await writeFolderCache({
    ...cache,
    rootId,
    deviceId: deviceFolderId,
    categoryIds,
  });

  return { deviceFolderId, categoryFolderId };
}

// ---------------------------------------------------------------------------
// Manifest read/write
// ---------------------------------------------------------------------------

function buildDefaultManifest(info: DeviceInfo): DeviceManifest {
  const now = new Date().toISOString();
  return {
    version: MANIFEST_VERSION,
    device_id: info.device_id,
    device_name: info.device_name,
    device_model: info.device_model,
    os_version: info.os_version,
    app_version: info.app_version,
    created_at: now,
    backups: {
      camera_roll: {
        enabled: false,
        last_sync: null,
        items_synced: 0,
        include_videos: true,
        wifi_only: true,
        background_enabled: false,
      },
      contacts: {
        enabled: false,
        last_sync: null,
        items_synced: 0,
        contact_count: 0,
      },
      calendar: {
        enabled: false,
        last_sync: null,
        items_synced: 0,
        calendar_count: 0,
      },
    },
  };
}

async function findManifestFile(deviceFolderId: string): Promise<FileEntry | null> {
  // Early-exit cursor walk: a capped single page let a device folder with >200
  // entries hide the manifest, making the backup look fresh → duplicate manifest
  // / re-upload (task 0755).
  const match = await findFile(
    deviceFolderId,
    async (f) => !f.is_folder && (await decryptName(f)) === MANIFEST_FILENAME,
  );
  return match ?? null;
}

async function cleanupBrokenManifestCopies(deviceFolderId: string): Promise<void> {
  let children: FileEntry[];
  try {
    children = await listAllFiles(deviceFolderId);
  } catch (err) {
    console.warn('[BackupService] could not inspect device folder for broken manifests:', err);
    return;
  }

  await Promise.all(children.map(async (f) => {
    if (f.is_folder) return;
    if ((f.size_bytes ?? 0) > BROKEN_MANIFEST_MAX_BYTES) return;
    const decrypted = await decryptName(f);
    if (decrypted !== null) return;

    try {
      await deleteFile(f.id);
    } catch (err) {
      console.warn('[BackupService] could not remove broken manifest copy:', err);
    }
  }));
}

function readHeaderInt(headers: Headers, key: string): number | null {
  const value = headers.get(key) ?? headers.get(key.toLowerCase());
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function decryptDownloadedText(entry: FileEntry): Promise<string> {
  const enc = requireEncryption();
  const res = await downloadFile(entry.id);
  const encrypted = new Uint8Array(await res.arrayBuffer());
  const plaintextSize = entry.size_bytes;
  const chunkCount = readHeaderInt(res.headers, 'X-Chunk-Count') ?? entry.chunk_count ?? 1;
  const chunkSize = readHeaderInt(res.headers, 'X-Chunk-Size') ?? FALLBACK_CHUNK_SIZE;

  try {
    const parts: Uint8Array[] = [];
    let offset = 0;
    for (let i = 0; i < chunkCount; i += 1) {
      const isLast = i === chunkCount - 1;
      const chunkPlaintextSize = chunkCount === 1
        ? plaintextSize
        : isLast
          ? plaintextSize - i * chunkSize
          : chunkSize;
      const encryptedChunkSize = NONCE_LENGTH + chunkPlaintextSize + GCM_TAG_LENGTH;
      const nonce = encrypted.slice(offset, offset + NONCE_LENGTH);
      const ciphertext = encrypted.slice(offset + NONCE_LENGTH, offset + encryptedChunkSize);
      parts.push(await enc.decryptChunkFn(entry.id, nonce, ciphertext));
      offset += encryptedChunkSize;
    }

    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const plaintext = new Uint8Array(total);
    let writeOffset = 0;
    for (const part of parts) {
      plaintext.set(part, writeOffset);
      writeOffset += part.length;
    }
    return new TextDecoder().decode(plaintext);
  } catch (err) {
    const legacyPlaintext = new TextDecoder().decode(encrypted);
    if (legacyPlaintext.trim().startsWith('{')) return legacyPlaintext;
    throw err;
  }
}

async function ensureDeviceFolderId(): Promise<string> {
  // Use camera_roll as the seed category — ensureBackupFolders only differs
  // in which category subfolder it creates, and we don't need that here.
  const { deviceFolderId } = await ensureBackupFolders('camera_roll');
  return deviceFolderId;
}

export async function getDeviceManifest(): Promise<DeviceManifest | null> {
  const deviceFolderId = await ensureDeviceFolderId();
  const cache = await readFolderCache();

  const manifestFile = await findManifestFile(deviceFolderId);
  if (!manifestFile) return null;

  const text = await decryptDownloadedText(manifestFile);
  try {
    return mergeLegacyMigration(JSON.parse(text) as DeviceManifest, cache.legacyMigration);
  } catch {
    return null;
  }
}

async function writeManifest(manifest: DeviceManifest, deviceFolderId: string): Promise<void> {
  const json = JSON.stringify(manifest);
  if (!FileSystem.cacheDirectory) throw new Error('File cache unavailable');
  await cleanupBrokenManifestCopies(deviceFolderId);
  const existing = await findManifestFile(deviceFolderId);
  if (existing) {
    await deleteFile(existing.id);
  }

  const fileId = await generateFileId();
  const uri = `${FileSystem.cacheDirectory}device_manifest_${fileId}.json`;
  const enc = requireEncryption();

  await FileSystem.writeAsStringAsync(uri, json);
  try {
    await encryptedUpload({
      fileId,
      uri,
      name: MANIFEST_FILENAME,
      parentId: deviceFolderId,
      mimeType: 'application/json',
      encryptChunkFn: enc.encryptChunkFn,
      encryptMetadataFn: enc.encryptMetadataFn,
    });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

export async function updateDeviceManifest(updates: Partial<DeviceManifest>): Promise<void> {
  const deviceFolderId = await ensureDeviceFolderId();

  const cache = await readFolderCache();
  const current = (await getDeviceManifest()) ?? mergeLegacyMigration(
    buildDefaultManifest(await getDeviceInfo()),
    cache.legacyMigration,
  );
  const next: DeviceManifest = {
    ...current,
    ...updates,
    backups: {
      ...current.backups,
      ...(updates.backups ?? {}),
    },
  };

  await writeManifest(next, deviceFolderId);
}

export async function updateBackupCategoryState(
  category: BackupCategory,
  updates: Partial<BackupCategoryState>,
): Promise<void> {
  const { deviceFolderId } = await ensureBackupFolders(category);
  const info = await getDeviceInfo();
  const cache = await readFolderCache();
  const current = (await getDeviceManifest()) ?? mergeLegacyMigration(
    buildDefaultManifest(info),
    cache.legacyMigration,
  );

  const next: DeviceManifest = {
    ...current,
    device_name: info.device_name,
    device_model: info.device_model,
    os_version: info.os_version,
    app_version: info.app_version,
    backups: {
      ...current.backups,
      [category]: {
        ...current.backups[category],
        ...updates,
      },
    },
  };

  await writeManifest(next, deviceFolderId);
}

// ---------------------------------------------------------------------------
// Lifecycle: enable / disable a backup category
// ---------------------------------------------------------------------------

export async function initializeBackup(
  category: BackupCategory,
): Promise<void> {
  const { deviceFolderId } = await ensureBackupFolders(category);

  const info = await getDeviceInfo();
  const cache = await readFolderCache();
  const current = (await getDeviceManifest()) ?? mergeLegacyMigration(
    buildDefaultManifest(info),
    cache.legacyMigration,
  );

  const categoryState: BackupCategoryState = {
    ...current.backups[category],
    enabled: true,
  };

  const next: DeviceManifest = {
    ...current,
    device_name: info.device_name,
    device_model: info.device_model,
    os_version: info.os_version,
    app_version: info.app_version,
    backups: {
      ...current.backups,
      [category]: categoryState,
    },
  };

  await writeManifest(next, deviceFolderId);
}

export async function disableBackup(category: BackupCategory): Promise<void> {
  const deviceFolderId = await ensureDeviceFolderId();

  const current = await getDeviceManifest();
  // Nothing to disable if there's no manifest yet — the category was never enabled.
  if (!current) return;

  const next: DeviceManifest = {
    ...current,
    backups: {
      ...current.backups,
      [category]: {
        ...current.backups[category],
        enabled: false,
      },
    },
  };

  await writeManifest(next, deviceFolderId);
}

// ---------------------------------------------------------------------------
// Deletion behavior preference
// ---------------------------------------------------------------------------

/**
 * Read the user's deletion behavior preference from the device manifest.
 * Defaults to 'keep' (keep server copy when photo is removed from camera roll).
 */
export async function getDeletionBehavior(): Promise<'keep' | 'trash'> {
  const manifest = await getDeviceManifest();
  return manifest?.deletion_behavior ?? 'keep';
}

/**
 * Persist the user's deletion behavior preference to the device manifest.
 *   - 'keep'  — when a photo is deleted from the camera roll, the server copy remains
 *   - 'trash' — when a photo is deleted from the camera roll, queue server copy for deletion
 */
export async function setDeletionBehavior(behavior: 'keep' | 'trash'): Promise<void> {
  await updateDeviceManifest({ deletion_behavior: behavior });
}

// ---------------------------------------------------------------------------
// Keep vault unlocked for background backup
// ---------------------------------------------------------------------------

const KEEP_VAULT_UNLOCKED_KEY = 'bb_keep_vault_unlocked';

/**
 * Read the user's "keep vault unlocked for backup" preference.
 * When enabled, the backup bridge can re-load the master key from the iOS
 * Keychain without user interaction so uploads continue in the background.
 *
 * Stored in AsyncStorage (always readable, even when vault is locked) to
 * break the circular dependency: tryBackgroundUnlock() needs this value
 * BEFORE the vault is unlocked, but the encrypted manifest requires unlock.
 */
export async function getKeepVaultUnlocked(): Promise<boolean> {
  try {
    const value = await AsyncStorage.getItem(KEEP_VAULT_UNLOCKED_KEY);
    return value === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist the user's "keep vault unlocked for backup" preference.
 * Writes to AsyncStorage first (source of truth, always readable), then
 * best-effort updates the encrypted manifest for cross-device sync.
 */
export async function setKeepVaultUnlocked(enabled: boolean): Promise<void> {
  // Always write to local storage (readable when vault is locked)
  await AsyncStorage.setItem(KEEP_VAULT_UNLOCKED_KEY, enabled ? 'true' : 'false');

  // Also write to manifest if encryption is available (for cross-device sync)
  try {
    await updateDeviceManifest({ keep_vault_unlocked: enabled });
  } catch {
    // Manifest update is best-effort — local storage is the source of truth
  }
}
