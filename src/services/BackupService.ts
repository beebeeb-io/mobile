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
  listFiles,
  moveFile,
  renameFile,
  type FileEntry,
} from '../lib/api';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { encryptedMetadataToJson, encryptedMetadataPayloadToBytes, fileMetadataPlaintext } from '../lib/encrypted-metadata';
import { encryptedUpload, generateFileId } from '../lib/encrypted-upload';
import { guessMimeType } from '../lib/media';

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
  const folderId = await generateFileId();
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

async function selfHealKnownBackupMetadata(
  rootId: string,
  deviceFolderId: string,
  categoryIds: Record<BackupCategory, string>,
  deviceName: string,
): Promise<void> {
  let healed = 0;

  const normalize = async (entry: FileEntry | undefined, expectedName?: string): Promise<void> => {
    if (!entry) return;
    try {
      if (await normalizeBackupNameMetadata(entry, expectedName)) healed += 1;
    } catch (err) {
      console.warn('[BackupService] backup metadata self-heal failed:', err);
    }
  };

  try {
    const rootChildren = await listFiles(undefined);
    await normalize(rootChildren.find((entry) => entry.id === rootId), ROOT_FOLDER_NAME);
  } catch (err) {
    console.warn('[BackupService] could not self-heal backup root metadata:', err);
  }

  try {
    const backupRootChildren = await listFiles(rootId);
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

    const deviceChildren = await listFiles(deviceFolderId);
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
      const children = await listFiles(categoryIds[category]);
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
  const children = await listFiles(deviceFolderId);
  for (const f of children) {
    if (f.is_folder) continue;
    const decrypted = await decryptName(f);
    if (decrypted === MANIFEST_FILENAME) return f;
  }
  return null;
}

async function cleanupBrokenManifestCopies(deviceFolderId: string): Promise<void> {
  let children: FileEntry[];
  try {
    children = await listFiles(deviceFolderId);
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
