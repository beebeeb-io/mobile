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
  listFiles,
  moveFile,
  renameFile,
  uploadFile,
  type FileEntry,
} from '../lib/api';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { encryptedMetadataToJson, encryptedMetadataPayloadToBytes } from '../lib/encrypted-metadata';
import { generateFileId } from '../lib/encrypted-upload';
import type { BackupEncryptors as ContactsBackupEncryptors } from './ContactsExporter';

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

export type BackupEncryptors = ContactsBackupEncryptors;

/** Encryption functions needed by the backup folder machinery. */
export interface BackupEncryption {
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = 'beebeeb_device_id';
const FOLDER_CACHE_KEY = 'beebeeb_backup_folders';
const MANIFEST_FILENAME = '.device.json';
const MANIFEST_VERSION = 1;
const APP_VERSION = '1.0.0';

const ROOT_FOLDER_NAME = 'Backups';

const CATEGORY_FOLDERS: Record<BackupCategory, string> = {
  camera_roll: 'Camera Roll',
  contacts: 'Contacts',
  calendar: 'Calendar',
};

// ---------------------------------------------------------------------------
// SecureStore helpers (web fallback to localStorage so dev preview works)
// ---------------------------------------------------------------------------

async function storeGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function storeSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
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
  const metadataPlain = JSON.stringify({ name, mime_type: null });
  const encrypted = await enc.encryptMetadataFn(folderId, metadataPlain);
  return encryptedMetadataToJson(encrypted);
}

/** Encrypt a file name into the canonical JSON envelope the server expects. */
async function encryptFileName(fileId: string, name: string, mimeType?: string): Promise<string> {
  const enc = requireEncryption();
  const metadataPlain = JSON.stringify({ name, mime_type: mimeType ?? null });
  const encrypted = await enc.encryptMetadataFn(fileId, metadataPlain);
  return encryptedMetadataToJson(encrypted);
}

/**
 * Decrypt a name_encrypted value to its plaintext name. Returns null if the
 * value is not a valid encrypted envelope (legacy plaintext).
 */
async function decryptName(entry: FileEntry): Promise<string | null> {
  const enc = requireEncryption();
  const parsed = encryptedMetadataPayloadToBytes(entry.name_encrypted);
  if (!parsed) {
    // Legacy plaintext name — return as-is for backward compat during migration
    return entry.name_encrypted;
  }
  try {
    const metadataJson = await enc.decryptMetadataFn(entry.id, parsed.nonce, parsed.ciphertext);
    const metadata = JSON.parse(metadataJson) as { name?: string };
    return metadata.name ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Folder management
// ---------------------------------------------------------------------------

async function findChildFolder(parentId: string | undefined, name: string): Promise<FileEntry | null> {
  const children = await listFiles(parentId);
  for (const f of children) {
    if (!f.is_folder) continue;
    const decrypted = await decryptName(f);
    if (decrypted === name) return f;
  }
  return null;
}

async function ensureFolder(parentId: string | undefined, name: string): Promise<string> {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing.id;
  const folderId = generateFileId();
  const nameEncrypted = await encryptFolderName(folderId, name);
  const created = await createFolder(nameEncrypted, parentId, folderId);
  return created.id;
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
    rootChildren = await listFiles(undefined);
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

/** Ensure `Backups/{deviceName}/{category}/` exists. Returns the device folder
 *  ID and the category folder ID. Caches results in SecureStore so subsequent
 *  calls skip the round-trips. */
export async function ensureBackupFolders(
  category: BackupCategory,
): Promise<{ deviceFolderId: string; categoryFolderId: string }> {
  let cache = await readFolderCache();

  let rootId = cache.rootId;
  rootId = await ensureFolder(undefined, ROOT_FOLDER_NAME);

  let deviceFolderId = cache.deviceId;
  const info = await getDeviceInfo();
  deviceFolderId = await ensureFolder(rootId, info.device_name);

  const categoryFolderName = CATEGORY_FOLDERS[category];
  let categoryFolderId = cache.categoryIds?.[category];
  categoryFolderId = await ensureFolder(deviceFolderId, categoryFolderName);

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
  const children = await listFiles(deviceFolderId);
  for (const f of children) {
    if (f.is_folder) continue;
    const decrypted = await decryptName(f);
    if (decrypted === MANIFEST_FILENAME) return f;
  }
  return null;
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

  const res = await downloadFile(manifestFile.id);
  const text = await res.text();
  try {
    return mergeLegacyMigration(JSON.parse(text) as DeviceManifest, cache.legacyMigration);
  } catch {
    return null;
  }
}

async function writeManifest(manifest: DeviceManifest, deviceFolderId: string): Promise<void> {
  const json = JSON.stringify(manifest);
  const blob = new Blob([json], { type: 'application/json' });

  const existing = await findManifestFile(deviceFolderId);
  if (existing) {
    await deleteFile(existing.id);
  }

  const fileId = generateFileId();
  const nameEncrypted = await encryptFileName(fileId, MANIFEST_FILENAME, 'application/json');

  await uploadFile(
    {
      name_encrypted: nameEncrypted,
      parent_id: deviceFolderId,
      mime_type: null as unknown as string,
      size_bytes: blob.size,
    },
    blob,
  );
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
  _encryption?: BackupEncryptors,
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
