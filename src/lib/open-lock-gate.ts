// FilesScreen's tap-to-open path for a row: the "Lock file" gate plus the
// folder / pending-upload / Preview dispatch that follows it.
//
// Bug (flow "iOS core journeys", P2): FilesScreen.openFile ran
// `isFileLocked` + `authenticateAsync` for EVERY entry, files included, and
// then PreviewScreen enforced its own gate (task 1539, preview-lock-gate.ts)
// without knowing the user had just authenticated — so a locked file opened
// from the Files tab asked for Face ID twice. PhotosScreen.openPhoto dropped
// the identical pre-check for the identical reason (PR #109 review).
//
// Fix: for FILES, Preview is the single enforcement point — it fails closed
// before its SecureStore read resolves and then requires a tap-to-authenticate
// for a locked file, so this gate lets navigation proceed without prompting.
// For FOLDERS there is no Preview behind the tap: FilesScreen is the only
// gate, so a locked folder still prompts here and a failed prompt blocks
// navigation.
//
// The whole of FilesScreen.openFile's decision lives in `openFilesEntry` so the
// real call path is unit-testable without rendering the screen
// (open-lock-gate.test.ts). FilesScreen.openFile only wires React callbacks
// into it; the same test file source-checks that it stays that way.

import * as LocalAuthentication from 'expo-local-authentication';
import { isFileLocked } from './file-locks';

/** Whether FilesScreen may proceed to open `entry` (navigate into a folder or push Preview). */
export async function passesOpenLockGate(entry: { id: string; is_folder: boolean }): Promise<boolean> {
  if (!entry.is_folder) return true; // PreviewScreen gates locked files itself.
  if (!(await isFileLocked(entry.id))) return true;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Authenticate to open this folder',
    disableDeviceFallback: true,
  });
  return result.success;
}

export type OpenFilesEntryOutcome = 'blocked' | 'folder' | 'pending-upload' | 'not-ready' | 'preview';

export interface OpenFilesEntryDeps<E> {
  navigateToFolder: (entry: E) => void;
  handlePendingUpload: (entry: E) => Promise<void>;
  ensureFileReady: (entry: E) => Promise<boolean>;
  openPreview: (entry: E) => void;
}

/** FilesScreen.openFile: gate, then open the tapped row. Errors propagate to the caller's toast. */
export async function openFilesEntry<E extends { id: string; is_folder: boolean; is_uploading?: boolean | null }>(
  entry: E,
  deps: OpenFilesEntryDeps<E>,
): Promise<OpenFilesEntryOutcome> {
  if (!(await passesOpenLockGate(entry))) return 'blocked';
  if (entry.is_folder) {
    deps.navigateToFolder(entry);
    return 'folder';
  }
  if (entry.is_uploading === true) {
    await deps.handlePendingUpload(entry);
    return 'pending-upload';
  }
  if (!(await deps.ensureFileReady(entry))) return 'not-ready';
  deps.openPreview(entry);
  return 'preview';
}
