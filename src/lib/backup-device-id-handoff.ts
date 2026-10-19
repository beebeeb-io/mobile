/**
 * Task 1667: the native engine records every completed upload in the server's
 * per-device photo-backup map, and rebuilds an empty manifest (after sign-out
 * or a reinstall) from it, both keyed by `X-Beebeeb-Device-Id`. It must be the
 * canonical id (`getDeviceId()`), the one the server already keys this device
 * by.
 *
 * Round 13 (review of mobile#182 at a19037f9, item 1, duplicate upload): only
 * an id that was READ from secure storage, or minted on a first run AND
 * durably persisted, is handed over. Before, the handoff ran at every
 * `BackupProvider` mount; when the keychain read failed (device locked: the
 * item is WHEN_UNLOCKED), `getDeviceId()` minted a new UUID, native stored it
 * over the real id, and every later /check, /identifiers and /mark used it,
 * so after the next sign-in the real map looked empty and photos uploaded
 * again. Now a failed read sends nothing (native keeps what it has), and the
 * handoff says the id is durable so native may replace a different one
 * (`NativeBackupEngine.backupDeviceId` refuses an undurable replacement).
 *
 * Its own module (no React) so the real composition is unit testable.
 */
import { Platform } from 'react-native';
import { setBackupDeviceId } from '../../modules/beebeeb-crypto';
import { resolveDeviceId, type DeviceIdResolution } from './device-identity';

export interface BackupDeviceIdHandoffDeps {
  resolveDeviceId: () => Promise<DeviceIdResolution>;
  setBackupDeviceId: (id: string, options: { persisted: boolean }) => Promise<boolean>;
}

/** Best-effort; resolves false when nothing was handed over. */
export async function syncBackupDeviceIdToNative(
  deps: BackupDeviceIdHandoffDeps = { resolveDeviceId, setBackupDeviceId },
): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  let resolution: DeviceIdResolution;
  try {
    resolution = await deps.resolveDeviceId();
  } catch {
    // Secure storage could not be read (locked device): the id may exist, so
    // nothing is minted and nothing is sent. Native keeps the id it has.
    return false;
  }
  // A minted id whose write failed lives in this JS session only: never hand
  // it to native, which persists it for background runs.
  if (!resolution.id || !resolution.persisted) return false;
  try {
    return await deps.setBackupDeviceId(resolution.id, { persisted: true });
  } catch {
    return false;
  }
}
