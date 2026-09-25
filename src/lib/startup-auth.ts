export type StartupAuthState =
  | 'unknown'
  | 'no-token'
  | 'token-present'
  | 'token-read-timeout'
  | 'secure-storage-unavailable'
  | 'restored'
  | 'invalid-token';

export type StartupAuthUiDecision =
  | 'keep-restoring'
  | 'show-authenticated'
  | 'show-signed-out'
  | 'show-secure-storage-error';

export function decideStartupAuthUi(state: StartupAuthState): StartupAuthUiDecision {
  switch (state) {
    case 'restored':
      return 'show-authenticated';
    case 'no-token':
    case 'invalid-token':
      return 'show-signed-out';
    case 'secure-storage-unavailable':
      return 'show-secure-storage-error';
    case 'unknown':
    case 'token-present':
    case 'token-read-timeout':
      return 'keep-restoring';
  }
}

export function shouldKeepStartupRestoring(state: StartupAuthState): boolean {
  return decideStartupAuthUi(state) === 'keep-restoring';
}

/** The session-token read did not settle within the recovery window. */
export class StartupTokenReadRecoveryError extends Error {
  constructor() {
    super('startup_token_read_recovery_timeout');
    this.name = 'StartupTokenReadRecoveryError';
  }
}

/**
 * The session-token read from the device's secure storage (iOS Keychain /
 * Android Keystore via expo-secure-store) threw. This is a local device
 * condition — before first unlock, a protected-data timing race, a build
 * without keychain access — and must never be reported as a network outage.
 */
export class SecureStorageReadError extends Error {
  constructor(public readonly cause: unknown) {
    super('secure_storage_read_failed');
    this.name = 'SecureStorageReadError';
  }
}

/**
 * expo-secure-store raises its Keychain OSStatus failures as a CodedError
 * with code `ERR_KEY_CHAIN` (KeyChainException). Recognise that shape even
 * when it reaches us unwrapped.
 */
function isSecureStoreException(err: unknown): boolean {
  if (err instanceof SecureStorageReadError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code === 'ERR_KEY_CHAIN';
}

/** `ApiError` from ./api, matched structurally so this module stays native-free. */
function apiErrorStatus(err: unknown): number | null {
  if (err instanceof Error && err.name === 'ApiError') {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

export function classifyStartupError(err: unknown): string {
  if (isSecureStoreException(err)) return 'secure-storage';
  const status = apiErrorStatus(err);
  if (status !== null) {
    if (status === 0) return 'network';
    if (status === 401) return 'invalid-token';
    return `api-${status}`;
  }
  if (err instanceof StartupTokenReadRecoveryError) return 'token-read-timeout';
  if (err instanceof Error && err.message === 'timeout') return 'timeout';
  return 'exception';
}

/** The startup state to settle on after `err` escaped the startup flow. */
export function startupAuthStateForError(err: unknown, current: StartupAuthState): StartupAuthState {
  if (isSecureStoreException(err)) return 'secure-storage-unavailable';
  if (err instanceof StartupTokenReadRecoveryError) return 'token-read-timeout';
  return current;
}

export interface SecureStorageUnavailableCopy {
  title: string;
  body: string;
}

export function secureStorageUnavailableCopy(os: string): SecureStorageUnavailableCopy {
  const android = os === 'android';
  return {
    title: "Couldn't read this device's secure storage",
    body: android
      ? 'Your session key lives in the Android Keystore, and it was locked or unavailable just now. ' +
        'Unlock your phone and try again. Nothing has been deleted.'
      : 'Your session key lives in the iPhone Keychain, and it was locked or unavailable just now. ' +
        'Unlock your iPhone and try again. Nothing has been deleted.',
  };
}
