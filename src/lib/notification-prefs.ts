/**
 * Task 1578 — push notification preference defaults, as a pure module.
 *
 * Guus (TestFlight 218): "do i want to get notifications from that?, make it
 * an option but disabled by default". The `file_updated` push ("A file
 * changed on another device") is therefore OFF unless the user turned it on.
 * A preference the server does not report (key absent, null, or not a
 * boolean) falls back to these defaults, so the Settings toggle shows OFF
 * for `file_updated` when the server has no value.
 */
export interface NotificationPreferences {
  file_updated: boolean;
  share_received: boolean;
  storage_warning: boolean;
  new_device_login: boolean;
  backup_complete: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Readonly<NotificationPreferences> = Object.freeze({
  file_updated: false,
  share_received: true,
  storage_warning: true,
  new_device_login: true,
  backup_complete: false,
});

const KEYS = Object.keys(DEFAULT_NOTIFICATION_PREFERENCES) as Array<keyof NotificationPreferences>;

/** Fills every missing or non-boolean key from `DEFAULT_NOTIFICATION_PREFERENCES`. */
export function normalizeNotificationPreferences(raw: unknown): NotificationPreferences {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const key of KEYS) {
    const v = src[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}
