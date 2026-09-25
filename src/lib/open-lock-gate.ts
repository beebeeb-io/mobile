// FilesScreen's pre-navigation "Lock file" gate for a tapped row.
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
// Kept free of React/navigation so it is unit-testable directly
// (open-lock-gate.test.ts), matching preview-lock-gate.ts.

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
