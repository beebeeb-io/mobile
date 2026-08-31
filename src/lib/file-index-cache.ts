import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { FileEntry } from './api';

const FILE_INDEX_CACHE_KEY = 'beebeeb:file-index-cache:v1';
const FILE_INDEX_CACHE_PATH = `${FileSystem.documentDirectory ?? ''}beebeeb-file-index-cache-v1.json`;

export interface CachedFileIndex {
  hash: string;
  files: FileEntry[];
  storedAt: number;
}

function isFileEntry(value: unknown): value is FileEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<FileEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.name_encrypted === 'string' &&
    typeof entry.size_bytes === 'number' &&
    typeof entry.is_folder === 'boolean' &&
    typeof entry.chunk_count === 'number' &&
    typeof entry.created_at === 'string' &&
    typeof entry.updated_at === 'string'
  );
}

export async function loadCachedFileIndex(): Promise<CachedFileIndex | null> {
  const disk = await loadFromDisk();
  if (disk) return disk;

  try {
    const raw = await AsyncStorage.getItem(FILE_INDEX_CACHE_KEY);
    if (!raw) return null;
    const parsed = parseCachedFileIndex(raw);
    if (!parsed) {
      await AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY);
      return null;
    }
    await saveCachedFileIndex(parsed.hash, parsed.files, parsed.storedAt).catch(() => {});
    await AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY).catch(() => {});
    return parsed;
  } catch {
    await AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY).catch(() => {});
    return null;
  }
}

// Ensure FileSystem.documentDirectory exists. On a fresh iOS install the
// Documents folder is created lazily by the system on first access, and an
// immediate writeAsStringAsync there raises "folder doesn't exist" with the
// filename as the offending path. Idempotent makeDirectoryAsync({intermediates:
// true}) is the documented expo-file-system pattern for this guard.
async function ensureDocumentDirectory(): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  try {
    await FileSystem.makeDirectoryAsync(FileSystem.documentDirectory, {
      intermediates: true,
    });
  } catch {
    // already exists or transient permission — writeAsStringAsync will surface
    // any real error
  }
}

export async function saveCachedFileIndex(
  hash: string,
  files: FileEntry[],
  storedAt = Date.now(),
): Promise<void> {
  const payload: CachedFileIndex = { hash, files, storedAt };
  const serialized = JSON.stringify(payload);
  if (FileSystem.documentDirectory) {
    await ensureDocumentDirectory();
    await FileSystem.writeAsStringAsync(FILE_INDEX_CACHE_PATH, serialized);
    return;
  }
  await AsyncStorage.setItem(FILE_INDEX_CACHE_KEY, serialized);
}

export async function clearCachedFileIndex(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(FILE_INDEX_CACHE_KEY),
    FileSystem.documentDirectory
      ? FileSystem.deleteAsync(FILE_INDEX_CACHE_PATH, { idempotent: true }).catch(() => {})
      : Promise.resolve(),
  ]);
}

async function loadFromDisk(): Promise<CachedFileIndex | null> {
  if (!FileSystem.documentDirectory) return null;
  try {
    const info = await FileSystem.getInfoAsync(FILE_INDEX_CACHE_PATH);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(FILE_INDEX_CACHE_PATH);
    const parsed = parseCachedFileIndex(raw);
    if (!parsed) {
      await FileSystem.deleteAsync(FILE_INDEX_CACHE_PATH, { idempotent: true }).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    await FileSystem.deleteAsync(FILE_INDEX_CACHE_PATH, { idempotent: true }).catch(() => {});
    return null;
  }
}

function parseCachedFileIndex(raw: string): CachedFileIndex | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CachedFileIndex>;
    if (
      typeof parsed.hash !== 'string' ||
      !Array.isArray(parsed.files) ||
      typeof parsed.storedAt !== 'number' ||
      !parsed.files.every(isFileEntry)
    ) {
      return null;
    }
    return { hash: parsed.hash, files: parsed.files, storedAt: parsed.storedAt };
  } catch {
    return null;
  }
}
