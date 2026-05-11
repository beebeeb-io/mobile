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
  uploadFile,
  type FileEntry,
} from '../lib/api';

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
}

export interface DeviceManifest {
  version: number;
  device_id: string;
  device_name: string;
  device_model: string;
  os_version: string;
  app_version: string;
  created_at: string;
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

// ---------------------------------------------------------------------------
// Folder management
// ---------------------------------------------------------------------------

async function findChildFolder(parentId: string | undefined, name: string): Promise<FileEntry | null> {
  const children = await listFiles(parentId);
  return children.find((f) => f.is_folder && f.name_encrypted === name) ?? null;
}

async function ensureFolder(parentId: string | undefined, name: string): Promise<string> {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing.id;
  const created = await createFolder(name, parentId);
  return created.id;
}

/** Ensure `Backups/{deviceName}/{category}/` exists. Returns the device folder
 *  ID and the category folder ID. Caches results in SecureStore so subsequent
 *  calls skip the round-trips. */
export async function ensureBackupFolders(
  category: BackupCategory,
): Promise<{ deviceFolderId: string; categoryFolderId: string }> {
  const cache = await readFolderCache();

  let rootId = cache.rootId;
  rootId = await ensureFolder(undefined, ROOT_FOLDER_NAME);

  let deviceFolderId = cache.deviceId;
  const info = await getDeviceInfo();
  deviceFolderId = await ensureFolder(rootId, info.device_name);

  const categoryFolderName = CATEGORY_FOLDERS[category];
  let categoryFolderId = cache.categoryIds?.[category];
  categoryFolderId = await ensureFolder(deviceFolderId, categoryFolderName);

  await writeFolderCache({
    rootId,
    deviceId: deviceFolderId,
    categoryIds: { ...(cache.categoryIds ?? {}), [category]: categoryFolderId },
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
  return children.find((f) => !f.is_folder && f.name_encrypted === MANIFEST_FILENAME) ?? null;
}

async function ensureDeviceFolderId(): Promise<string> {
  // Use camera_roll as the seed category — ensureBackupFolders only differs
  // in which category subfolder it creates, and we don't need that here.
  const { deviceFolderId } = await ensureBackupFolders('camera_roll');
  return deviceFolderId;
}

export async function getDeviceManifest(): Promise<DeviceManifest | null> {
  const cache = await readFolderCache();
  const deviceFolderId = cache.deviceId ?? (await ensureDeviceFolderId());

  const manifestFile = await findManifestFile(deviceFolderId);
  if (!manifestFile) return null;

  const res = await downloadFile(manifestFile.id);
  const text = await res.text();
  try {
    return JSON.parse(text) as DeviceManifest;
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

  await uploadFile(
    {
      name_encrypted: MANIFEST_FILENAME,
      parent_id: deviceFolderId,
      mime_type: 'application/json',
      size_bytes: blob.size,
    },
    blob,
  );
}

export async function updateDeviceManifest(updates: Partial<DeviceManifest>): Promise<void> {
  const deviceFolderId = await ensureDeviceFolderId();

  const current = (await getDeviceManifest()) ?? buildDefaultManifest(await getDeviceInfo());
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

// ---------------------------------------------------------------------------
// Lifecycle: enable / disable a backup category
// ---------------------------------------------------------------------------

export async function initializeBackup(category: BackupCategory): Promise<void> {
  const { deviceFolderId } = await ensureBackupFolders(category);

  const info = await getDeviceInfo();
  const current = (await getDeviceManifest()) ?? buildDefaultManifest(info);

  const categoryState: BackupCategoryState = {
    ...current.backups[category],
    enabled: true,
  };

  // Run the actual export. Done in JS via expo-contacts / expo-calendar so
  // the backup happens without native modules. Camera roll is handled by a
  // separate scanner — see BackupContext / BackupRunner.
  if (category === 'contacts') {
    try {
      // Lazy import to avoid pulling expo-contacts into the camera_roll path.
      const { exportContacts } = await import('./ContactsExporter');
      const result = await exportContacts();
      if (result.contactCount > 0) {
        categoryState.contact_count = result.contactCount;
        categoryState.items_synced = result.contactCount;
        if (result.exported) categoryState.last_sync = new Date().toISOString();
      }
    } catch (err) {
      console.warn('Contacts export failed:', err);
    }
  } else if (category === 'calendar') {
    try {
      const { exportCalendars } = await import('./CalendarExporter');
      const result = await exportCalendars();
      if (result.calendarCount > 0) {
        categoryState.calendar_count = result.calendarCount;
        categoryState.items_synced = result.eventCount;
        if (result.exported) categoryState.last_sync = new Date().toISOString();
      }
    } catch (err) {
      console.warn('Calendar export failed:', err);
    }
  }

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
