/**
 * Offline download manager (tasks 0793 / 0794).
 *
 * A process-wide singleton that owns the "make available offline" pipeline:
 *   - a concurrency-limited download queue with REAL byte progress (via
 *     `FileSystem.createDownloadResumable`), so the file row can show
 *     queued → downloading N% → available;
 *   - the on-disk manifest (which files + which folders the user pinned),
 *     persisted to SecureStore so state survives relaunch;
 *   - a version-counter subscription so React can re-render via
 *     `useSyncExternalStore` without prop-drilling.
 *
 * Privacy: downloads go ONLY to our own API (`getDownloadUrl`) and the bytes
 * written to `OFFLINE_DIR` are the SAME end-to-end-encrypted blobs the server
 * stores — they are NOT decrypted at rest. Decryption happens client-side at
 * open time, exactly like the streaming preview path. No cloud round-trip, no
 * plaintext on disk.
 */

import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { getDownloadUrl, getToken } from './api';

export type OfflineState = 'queued' | 'downloading' | 'available' | 'error';

export interface OfflineStatus {
  state: OfflineState;
  /** 0..1 — only meaningful while `downloading`. */
  progress: number;
}

export interface OfflineAggregate {
  state: OfflineState;
  /** 0..1 across the whole set. */
  progress: number;
  total: number;
  done: number;
}

interface ManifestEntry {
  fileId: string;
  fileName: string;
  savedAt: string;
}

interface PersistedManifest {
  files: ManifestEntry[];
  folders: string[];
}

const OFFLINE_KEY = 'beebeeb_offline_files';
const OFFLINE_FOLDERS_KEY = 'beebeeb_offline_folders';
export const OFFLINE_DIR = `${FileSystem.documentDirectory}offline/`;
const MAX_CONCURRENT = 3;

export function offlineFilePath(fileId: string): string {
  return `${OFFLINE_DIR}${fileId}`;
}

type Listener = () => void;

interface QueueJob {
  fileId: string;
  fileName: string;
}

class OfflineManager {
  private status = new Map<string, OfflineStatus>();
  private manifest = new Map<string, ManifestEntry>();
  private folders = new Set<string>();
  private queue: QueueJob[] = [];
  private activeCount = 0;
  private initialized = false;
  private listeners = new Set<Listener>();
  private version = 0;

  // -- subscription (useSyncExternalStore) ---------------------------------

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getVersion = (): number => this.version;

  private emit() {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  // -- lifecycle -----------------------------------------------------------

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const rawFiles = await SecureStore.getItemAsync(OFFLINE_KEY);
      if (rawFiles) {
        const list = JSON.parse(rawFiles) as ManifestEntry[];
        for (const entry of list) {
          this.manifest.set(entry.fileId, entry);
          this.status.set(entry.fileId, { state: 'available', progress: 1 });
        }
      }
      const rawFolders = await SecureStore.getItemAsync(OFFLINE_FOLDERS_KEY);
      if (rawFolders) {
        for (const id of JSON.parse(rawFolders) as string[]) this.folders.add(id);
      }
    } catch {
      // Corrupt manifest — start clean rather than crash.
    }
    this.emit();
  }

  // -- queries -------------------------------------------------------------

  getStatus(fileId: string): OfflineStatus | undefined {
    return this.status.get(fileId);
  }

  isAvailable(fileId: string): boolean {
    return this.status.get(fileId)?.state === 'available';
  }

  isFolderOffline(folderId: string): boolean {
    return this.folders.has(folderId);
  }

  /** Aggregate status across a set of file ids (for a folder row, 0794). */
  aggregate(fileIds: string[]): OfflineAggregate {
    const total = fileIds.length;
    if (total === 0) return { state: 'available', progress: 1, total: 0, done: 0 };
    let done = 0;
    let progressSum = 0;
    let anyError = false;
    let anyActive = false;
    for (const id of fileIds) {
      const st = this.status.get(id);
      if (!st) continue;
      if (st.state === 'available') {
        done += 1;
        progressSum += 1;
      } else if (st.state === 'downloading' || st.state === 'queued') {
        anyActive = true;
        progressSum += st.progress;
      } else if (st.state === 'error') {
        anyError = true;
      }
    }
    const progress = progressSum / total;
    let state: OfflineState;
    if (done === total) state = 'available';
    else if (anyActive) state = 'downloading';
    else if (anyError) state = 'error';
    else state = 'queued';
    return { state, progress, total, done };
  }

  // -- mutations -----------------------------------------------------------

  /** Enqueue one or more files for offline download (idempotent). */
  makeFilesAvailable(files: { id: string; name: string }[]): void {
    let changed = false;
    for (const f of files) {
      const st = this.status.get(f.id);
      if (st && (st.state === 'available' || st.state === 'downloading' || st.state === 'queued')) {
        continue;
      }
      this.status.set(f.id, { state: 'queued', progress: 0 });
      this.queue.push({ fileId: f.id, fileName: f.name });
      changed = true;
    }
    if (changed) {
      this.emit();
      this.pump();
    }
  }

  markFolderOffline(folderId: string): void {
    if (!this.folders.has(folderId)) {
      this.folders.add(folderId);
      void this.persistFolders();
      this.emit();
    }
  }

  async removeFile(fileId: string): Promise<void> {
    this.queue = this.queue.filter((j) => j.fileId !== fileId);
    this.status.delete(fileId);
    this.manifest.delete(fileId);
    await FileSystem.deleteAsync(offlineFilePath(fileId), { idempotent: true }).catch(() => {});
    await this.persistFiles();
    this.emit();
  }

  /** Remove a folder pin and all of its (passed-in) descendant files. */
  async removeFolder(folderId: string, descendantFileIds: string[]): Promise<void> {
    this.folders.delete(folderId);
    this.queue = this.queue.filter((j) => !descendantFileIds.includes(j.fileId));
    for (const id of descendantFileIds) {
      this.status.delete(id);
      this.manifest.delete(id);
      await FileSystem.deleteAsync(offlineFilePath(id), { idempotent: true }).catch(() => {});
    }
    await this.persistFiles();
    await this.persistFolders();
    this.emit();
  }

  // -- internals -----------------------------------------------------------

  private pump(): void {
    while (this.activeCount < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.activeCount += 1;
      void this.download(job).finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
    }
  }

  private async download(job: QueueJob): Promise<void> {
    const { fileId, fileName } = job;
    this.status.set(fileId, { state: 'downloading', progress: 0 });
    this.emit();
    let lastPct = -1;
    try {
      const dirInfo = await FileSystem.getInfoAsync(OFFLINE_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(OFFLINE_DIR, { intermediates: true });
      }
      const token = await getToken();
      if (!token) throw new Error('Not signed in');

      const resumable = FileSystem.createDownloadResumable(
        getDownloadUrl(fileId),
        offlineFilePath(fileId),
        { headers: { Authorization: `Bearer ${token}` } },
        (p) => {
          const total = p.totalBytesExpectedToWrite;
          const pct = total > 0 ? p.totalBytesWritten / total : 0;
          // Throttle re-renders to whole-percent changes.
          const whole = Math.round(pct * 100);
          if (whole === lastPct) return;
          lastPct = whole;
          this.status.set(fileId, { state: 'downloading', progress: pct });
          this.emit();
        },
      );

      const result = await resumable.downloadAsync();

      // If the user removed this file while it was downloading, its status was
      // deleted — honor that, drop the bytes, and don't re-add to the manifest.
      if (!this.status.has(fileId)) {
        await FileSystem.deleteAsync(offlineFilePath(fileId), { idempotent: true }).catch(() => {});
        return;
      }
      if (!result || result.status >= 400) {
        throw new Error(`Download failed (${result?.status ?? 'no response'})`);
      }

      this.manifest.set(fileId, { fileId, fileName, savedAt: new Date().toISOString() });
      this.status.set(fileId, { state: 'available', progress: 1 });
      await this.persistFiles();
      this.emit();
    } catch {
      this.status.set(fileId, { state: 'error', progress: 0 });
      await FileSystem.deleteAsync(offlineFilePath(fileId), { idempotent: true }).catch(() => {});
      this.emit();
    }
  }

  private async persistFiles(): Promise<void> {
    const payload: ManifestEntry[] = [...this.manifest.values()];
    await SecureStore.setItemAsync(OFFLINE_KEY, JSON.stringify(payload)).catch(() => {});
  }

  private async persistFolders(): Promise<void> {
    await SecureStore.setItemAsync(OFFLINE_FOLDERS_KEY, JSON.stringify([...this.folders])).catch(() => {});
  }

  /** Test seam. */
  __snapshotForTest(): { statuses: Record<string, OfflineStatus>; folders: string[] } {
    return {
      statuses: Object.fromEntries(this.status),
      folders: [...this.folders],
    };
  }
}

export const offlineManager = new OfflineManager();
export type { PersistedManifest };
