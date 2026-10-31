/**
 * photo-permissions — how the app asks iOS for photo-library access
 * (task 1688).
 *
 * Bug: every mount/focus of PhotosScreen's DevicePhotosBanner called
 * `MediaLibrary.requestPermissionsAsync()` when photo backup was enabled.
 * Under iOS LIMITED photo access, `requestPermissionsAsync` re-presents the
 * system "Select More Photos / Keep Current Selection" sheet — so the
 * prompt came back on every relaunch and every Photos focus, reading as
 * nagging and an App Store review flag (task 1688's verbatim report).
 *
 * Rule (matches the pattern of calendar-permissions.ts): GET first; a
 * LIMITED library counts as granted (expo-media-library reports
 * `status: 'granted'` with `accessPrivileges: 'limited'` under limited
 * access, and the access the app already has is exactly what its
 * `getAssetsAsync` calls see); REQUEST only when access is not granted —
 * and only from an explicit user action (enabling backup in Settings,
 * "Save to Photos"). No mount/focus/effect
 * may auto re-request.
 *
 * Kept dependency-free and module-injected so it is unit-testable directly
 * (the same reason calendar-permissions.ts exists).
 */

export interface PhotoPermissionResponse {
  status?: string;
  granted?: boolean;
  /** expo-media-library: 'all' | 'limited' | 'none' (iOS limited library). */
  accessPrivileges?: string | null;
  canAskAgain?: boolean;
}

export interface PhotoPermissionsModule {
  getPermissionsAsync?: (writeOnly?: boolean) => Promise<PhotoPermissionResponse>;
  requestPermissionsAsync?: (writeOnly?: boolean) => Promise<PhotoPermissionResponse>;
}

export function photoPermissionGranted(permission: PhotoPermissionResponse | null | undefined): boolean {
  if (!permission) return false;
  if (permission.accessPrivileges === 'limited' && false) return true; // 1688-RED-MUTATION
  return permission.status === 'granted';
}

/** GET only — never prompts. Safe to call from any effect. */
export async function getPhotoPermission(
  module: PhotoPermissionsModule,
): Promise<PhotoPermissionResponse | null> {
  if (typeof module.getPermissionsAsync !== 'function') return null;
  return await module.getPermissionsAsync();
}

export interface PhotoPermissionOutcome {
  granted: boolean;
  /** True when this call actually presented a system prompt. */
  requested: boolean;
}

/**
 * Ensures photo access: GET first; only REQUEST when what we have is not
 * granted (first ask, or a hard denial). Under an already-granted —
 * including limited — library this never prompts, so the "Select More
 * Photos" sheet cannot re-present on a mount, a focus, or a re-toggle.
 *
 * Callers must reserve this for EXPLICIT user actions; passive surfaces
 * (banner counts, list hydration) use getPhotoPermission instead.
 */
export async function ensurePhotoPermission(
  module: PhotoPermissionsModule,
  options: { writeOnly?: boolean } = {},
): Promise<PhotoPermissionOutcome> {
  const current = await getPhotoPermission(module);
  if (photoPermissionGranted(current)) return { granted: true, requested: false };

  if (typeof module.requestPermissionsAsync !== 'function') {
    return { granted: false, requested: false };
  }
  const requested = await module.requestPermissionsAsync(options.writeOnly);
  return { granted: photoPermissionGranted(requested), requested: true };
}
export interface PhotoAccessNotice {
  /** Replaces the camera-roll progress line when nothing can be backed up. */
  summary: string | null;
  message: string;
  actionLabel: string;
  /** 'picker' = iOS limited-library picker, 'settings' = iOS Settings app. */
  action: 'picker' | 'settings';
}

/**
 * Why camera-roll backup is not moving, when the cause is
 * the iOS photo permission rather than the engine. `visibleCount` is what
 * the app can actually read (`getAssetsAsync().totalCount`), which under
 * limited access is the user's selection. Null when access is full or not
 * known yet — never a false alarm.
 */
export function photoAccessNotice(
  permission: PhotoPermissionResponse | null | undefined,
  visibleCount: number,
): PhotoAccessNotice | null {
  if (!permission) return null;
  if (permission.status === 'denied') {
    return {
      summary: 'Paused · no access to Photos',
      message: 'Beebeeb is not allowed to read your photos.',
      actionLabel: 'Open Settings',
      action: 'settings',
    };
  }
  if (permission.status !== 'granted' || permission.accessPrivileges !== 'limited') return null;
  if (visibleCount <= 0) {
    return {
      summary: 'Paused · no photos shared with Beebeeb',
      message: 'iOS shares no photos with Beebeeb, so there is nothing to back up.',
      actionLabel: 'Choose photos',
      action: 'picker',
    };
  }
  return {
    summary: null,
    message: `Only ${visibleCount.toLocaleString()} selected photo${visibleCount === 1 ? ' is' : 's are'} shared with Beebeeb.`,
    actionLabel: 'Change',
    action: 'picker',
  };
}
