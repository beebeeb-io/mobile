// expo-calendar 57 promoted the object-oriented "Calendar Next" API to the
// package root and moved the old flat-function API to `expo-calendar/legacy`
// (see its CHANGELOG, 56.0.7). The root module still exports the OLD names
// (`getCalendarPermissionsAsync`/`requestCalendarPermissionsAsync`) — but only
// as deprecated shims that unconditionally THROW when called (they exist
// purely to point migrators at the new names; see
// `expo-calendar/build/legacyWarnings.js`). They are not simply absent, so a
// `Calendar.getCalendarPermissionsAsync ?? Calendar.getPermissionsAsync`-style
// fallback finds the throwing shim first and never falls through to a working
// implementation — this is what broke the calendar backup toggle on SDK 57
// (task 1390). Use the new root names (`getCalendarPermissions` /
// `requestCalendarPermissions`, no `Async` suffix) directly instead.

export interface CalendarPermissionResponse {
  status?: string;
  granted?: boolean;
}

export interface CalendarPermissionsModule {
  getCalendarPermissions?: (writeOnly?: boolean) => Promise<CalendarPermissionResponse>;
  requestCalendarPermissions?: (writeOnly?: boolean) => Promise<CalendarPermissionResponse>;
}

export function calendarPermissionGranted(
  permission: CalendarPermissionResponse | null | undefined,
): boolean {
  return permission?.granted === true || permission?.status === 'granted';
}

/**
 * Ensures the app holds calendar access, requesting it if necessary.
 *
 * Requests FULL access (the default, `writeOnly` omitted) — calendar backup
 * reads existing events, not just creates new ones.
 *
 * Throws if the underlying module call itself throws (a module API mismatch
 * or native-side failure). That is DISTINCT from the user denying access,
 * which resolves normally to `false`. Callers must not conflate the two: a
 * thrown error means "something is broken and needs a visible error", a
 * resolved `false` means "ask the user to grant access in Settings".
 */
export async function ensureCalendarPermission(
  calendarModule: CalendarPermissionsModule,
): Promise<boolean> {
  const getPermission = calendarModule.getCalendarPermissions;
  const requestPermission = calendarModule.requestCalendarPermissions;

  const current = typeof getPermission === 'function' ? await getPermission() : null;
  if (calendarPermissionGranted(current)) return true;

  const requested = typeof requestPermission === 'function' ? await requestPermission() : null;
  return calendarPermissionGranted(requested);
}
