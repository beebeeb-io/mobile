// Namespace import: a test's native mock without these functions leaves them
// undefined (nothing mirrored), never a load error.
import * as NativeCrypto from '../../modules/beebeeb-crypto';
import { accountEpoch, isCurrentAccountEpoch, onAccountEpochAdvance, type AccountEpoch } from './account-epoch';
import {
  DEFAULT_PHOTO_PREVIEW_SETTING,
  loadPhotoPreviewSettingStrict,
  parsePhotoPreviewSetting,
  type PhotoPreviewSetting,
} from './photo-preview-settings';

const PREFERENCE_KEY = 'photo_previews';

/** The setting last read or mirrored in this session, and the account it belongs to. */
let known: { setting: PhotoPreviewSetting; epoch: AccountEpoch } | null = null;
/** The account the native mirror was last written for, within this session. */
let mirroredAccount: { generation: number; accountId: string } | null = null;
const listeners = new Set<(setting: PhotoPreviewSetting) => void>();

onAccountEpochAdvance(() => {
  known = null;
  mirroredAccount = null;
});

function mirrorAccountId(explicit: string | null | undefined): string | null {
  if (explicit) return explicit;
  const epoch = accountEpoch();
  if (epoch.accountId) return epoch.accountId;
  return mirroredAccount && mirroredAccount.generation === epoch.generation ? mirroredAccount.accountId : null;
}

/**
 * Keep the native backup engine in step with the account's photo preview setting.
 * Call on every load and every change (including Off); the engine only makes previews
 * while the mirrored setting is enabled for the account of the batch it uploads. An
 * unknown account mirrors a setting no batch can match (disabled).
 */
export function mirrorPhotoPreviewSetting(setting: PhotoPreviewSetting, accountId?: string | null): void {
  const owner = mirrorAccountId(accountId);
  try {
    NativeCrypto.setPhotoPreviewSetting?.(setting.enabled, setting.format, setting.px, owner);
  } catch (err) {
    console.warn('[photo-preview-sync] native mirror failed', err);
  }
  const epoch = accountEpoch();
  if (owner) mirroredAccount = { generation: epoch.generation, accountId: owner };
  known = { setting: { ...setting }, epoch };
  for (const listener of [...listeners]) {
    try {
      listener({ ...setting });
    } catch {
      // A listener never breaks the mirror.
    }
  }
}

/** Called with the new setting whenever it is mirrored (screen change, sync op, re-sync). */
export function onPhotoPreviewSettingChange(listener: (setting: PhotoPreviewSetting) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch the account setting and mirror it natively. Best effort; never throws. When the
 * setting cannot be read the native value is left as it was (never reset to Off); it is
 * account-scoped natively, so another account's value never applies.
 */
export async function syncPhotoPreviewSettingToNative(accountId?: string | null): Promise<void> {
  const epoch = accountEpoch();
  try {
    const setting = await loadPhotoPreviewSettingStrict();
    if (!isCurrentAccountEpoch(epoch)) return;
    mirrorPhotoPreviewSetting(setting, accountId);
  } catch (err) {
    console.warn('[photo-preview-sync] could not load the photo preview setting', err);
  }
}

/**
 * The setting for this session: the last value read or mirrored, else one strict
 * read (cached on success). A failed read answers the default (Off) uncached.
 */
export async function getSessionPhotoPreviewSetting(): Promise<PhotoPreviewSetting> {
  if (known && isCurrentAccountEpoch(known.epoch)) return { ...known.setting };
  const epoch = accountEpoch();
  try {
    const setting = await loadPhotoPreviewSettingStrict();
    if (isCurrentAccountEpoch(epoch)) known = { setting: { ...setting }, epoch };
    return setting;
  } catch {
    return { ...DEFAULT_PHOTO_PREVIEW_SETTING };
  }
}

/** The setting last read or mirrored for the current account, without asking the server. */
export function knownPhotoPreviewSetting(): PhotoPreviewSetting | null {
  return known && isCurrentAccountEpoch(known.epoch) ? { ...known.setting } : null;
}

/**
 * A `preference_update` sync op. Only `photo_previews` is handled: it is mirrored
 * natively and every open settings screen follows. Anything else is ignored.
 */
export function applyPreferenceUpdateOp(payload: Record<string, unknown>): boolean {
  if (payload.key !== PREFERENCE_KEY) return false;
  let value = payload.value;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  mirrorPhotoPreviewSetting(parsePhotoPreviewSetting(value));
  return true;
}

export type ScreenSettingLoad =
  | { status: 'loaded'; setting: PhotoPreviewSetting }
  | { status: 'failed' };

/**
 * For the settings screen: a read failure is "failed" (controls stay disabled), never
 * a default Off. A loaded setting is mirrored natively.
 */
export async function loadSettingForScreen(): Promise<ScreenSettingLoad> {
  try {
    const setting = await loadPhotoPreviewSettingStrict();
    mirrorPhotoPreviewSetting(setting);
    return { status: 'loaded', setting };
  } catch {
    return { status: 'failed' };
  }
}

/** Test hook. */
export function __resetPhotoPreviewSyncForTests(): void {
  known = null;
  mirroredAccount = null;
  listeners.clear();
}
