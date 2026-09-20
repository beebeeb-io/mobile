/**
 * One-shot seed of a welcome.md file into a brand-new account.
 *
 * Runs after successful recovery-phrase verification. Encrypted via the
 * existing upload pipeline — the server never sees the plaintext copy.
 *
 * Idempotency is double-guarded:
 *  1. Per-device SecureStore flag (`beebeeb_welcome_seeded__<userId>`). A second
 *     sign-in on the same device short-circuits before we hit the network.
 *  2. Server-side root-content check. If the user already has a real FILE
 *     (a non-folder entry) at root (e.g. they're signing in from a second
 *     device, or restored from a recovery phrase), we skip the seed entirely so
 *     we never spam duplicate welcome.md files into an established vault.
 *     NB: auto-created system folders (e.g. "Backups") are NOT real content and
 *     must not block the seed — that was the 0558 bug (every new account gets a
 *     Backups folder, so a "root non-empty" guard tripped on every fresh
 *     account and welcome.md never seeded).
 *
 * Failures are silent — a missing welcome file is not worth blocking the
 * post-onboarding navigation. Errors are surfaced via console.warn so a
 * verifier running with a debugger attached can see what happened.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { listFiles } from './api';
import { encryptedUpload, generateFileId } from './encrypted-upload';

const SEEDED_KEY_PREFIX = 'beebeeb_welcome_seeded';

export const WELCOME_FILENAME = 'welcome.md';

// Voice rules in `repos/core/brand/README.md`: honest over reassuring, name
// the city (Falkenstein), no flag emojis, no unmeasurable security-marketing
// adjectives.
export const WELCOME_MARKDOWN = `# Welcome to Beebeeb

This is your vault. Every file you upload is encrypted on this device with a key only you control — Beebeeb's servers never see plaintext, ever.

To get started:

- Tap **+** to upload a photo or document
- Open **Settings → Backup** to mirror your camera roll automatically
- Your **12-word recovery phrase** is the only way to restore access if you lose this device. Keep it somewhere safe and offline.

We can't recover your phrase for you. That's the trade-off for end-to-end encryption — and the whole point of choosing Beebeeb.

Stored in Falkenstein. Made in Europe.
`;

export interface SeedWelcomeOptions {
  userId: string;
  encryptChunkFn: (fileId: string, plaintext: Uint8Array) => Promise<EncryptedData>;
  encryptMetadataFn: (fileId: string, metadata: string) => Promise<EncryptedData>;
}

function seedKey(userId: string): string {
  // SecureStore keys must match `[A-Za-z0-9._-]+` (Expo enforces this —
  // `ensureValidKey`/`isValidKey` in expo-secure-store's SecureStore.js,
  // regex `/^[\w.-]+$/` — and THROWS "Invalid key provided to SecureStore"
  // for anything else). UUIDs already satisfy that; this sanitiser is a
  // belt-and-braces guard for any non-UUID user IDs we might see in the
  // future. The separator between prefix and userId must ALSO be in that
  // set — '__' here, not ':' (task 1444: ':' is invalid, confirmed against
  // the installed expo-secure-store version, so every getItemAsync /
  // setItemAsync call using the old key threw. Both call sites below already
  // swallow that throw, so this never broke seeding itself — guard 2, the
  // server-side root-content check, was the real idempotency backstop — but
  // this per-device fast-path never actually latched or short-circuited).
  return `${SEEDED_KEY_PREFIX}__${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/** Pre-1444 key shape. Kept ONLY for a best-effort backward-compat read — a
 *  platform whose SecureStore shim doesn't enforce Expo's native character
 *  set (this repo swallows SecureStore errors elsewhere for "web") could in
 *  principle have a flag stored under this key. A throw here is expected on
 *  every native platform (':' is invalid) and is treated as "not seeded",
 *  identically to any other lookup miss. */
function legacySeedKey(userId: string): string {
  return `${SEEDED_KEY_PREFIX}:${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * Returns true when this device has already attempted (successfully) to seed
 * welcome.md for the given user.
 */
export async function hasWelcomeBeenSeeded(userId: string): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(seedKey(userId));
    if (v === 'true') return true;
  } catch {
    // Fall through to the legacy-key check below.
  }
  try {
    const legacy = await SecureStore.getItemAsync(legacySeedKey(userId));
    return legacy === 'true';
  } catch {
    return false;
  }
}

async function markSeeded(userId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(seedKey(userId), 'true');
  } catch {
    // Non-fatal — worst case the seed runs once more on a future sign-in
    // and the root-content guard catches it.
  }
}

/**
 * Fire-and-forget welcome.md seed. Resolves to `true` when a file was uploaded,
 * `false` when skipped or failed. Never throws — failures are logged via
 * `console.warn` so they don't break the post-onboarding navigation.
 */
export async function seedWelcomeMarkdown(opts: SeedWelcomeOptions): Promise<boolean> {
  const { userId, encryptChunkFn, encryptMetadataFn } = opts;
  try {
    if (await hasWelcomeBeenSeeded(userId)) {
      console.info('[welcome-seed] seed skipped: already seeded on this device');
      return false;
    }

    // Server-side guard: if root already has a real FILE (non-folder), the user
    // has content (second device, restore from recovery phrase, or a prior
    // seed — welcome.md is itself a non-folder file), so don't seed. Folders are
    // ignored on purpose: the server auto-creates a "Backups" folder at root for
    // every new account, and counting it as "content" suppressed the seed on
    // every fresh account (task 0558). markSeeded only latches here (genuine
    // existing content) or after a successful upload — never on a transient
    // listFiles error (that path returns without latching, so it retries).
    // `listFiles(undefined, false)` is parent-scoped to ROOT ONLY — a file the
    // camera-roll backup already uploaded INSIDE the auto-created Backups
    // folder (task 1443) is never returned here and must never trip this guard.
    let existing;
    try {
      existing = await listFiles(undefined, false);
    } catch (err) {
      console.warn('[welcome-seed] seed skipped: could not list root files', err);
      return false;
    }
    if (existing.some((f) => !f.is_folder)) {
      await markSeeded(userId);
      console.info('[welcome-seed] seed skipped: root already has content');
      return false;
    }

    // Write the markdown to a temp file the upload pipeline can read.
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) {
      console.warn('[welcome-seed] seed skipped: no cache directory available');
      return false;
    }
    const tempUri = `${cacheDir}beebeeb-welcome-${Date.now()}.md`;
    await FileSystem.writeAsStringAsync(tempUri, WELCOME_MARKDOWN, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    try {
      const fileId = await generateFileId();
      await encryptedUpload({
        fileId,
        uri: tempUri,
        name: WELCOME_FILENAME,
        mimeType: 'text/markdown',
        encryptChunkFn,
        encryptMetadataFn,
      });
      await markSeeded(userId);
      console.info(`[welcome-seed] seed done: ${fileId}`);
      return true;
    } finally {
      // Best-effort cleanup of the plaintext temp file.
      try {
        await FileSystem.deleteAsync(tempUri, { idempotent: true });
      } catch {
        // Non-fatal — the OS will reclaim the cache directory eventually.
      }
    }
  } catch (err) {
    console.warn('[welcome-seed] seed failed:', err);
    return false;
  }
}

export interface EnsureUnlockedAndSeedOptions extends SeedWelcomeOptions {
  /** Snapshot of `useCrypto().isUnlocked` at the moment the caller decided to seed. */
  isUnlocked: boolean;
  /** `useCrypto().unlock` — idempotent: a fast no-op if already unlocked, and
   *  dedups with any unlock already in flight elsewhere (crypto-context.tsx's
   *  `unlockPromiseRef`), so calling it speculatively here is always safe. */
  unlock: () => Promise<void>;
}

/**
 * Guards `seedWelcomeMarkdown` against the CryptoProvider remount race
 * (task 1444).
 *
 * `<CryptoProvider key={user?.user_id ?? 'signed-out'}>` (App.tsx) tears down
 * and remounts the ENTIRE crypto context the instant `user.user_id` first
 * populates, because `SignupScreen.handleSignup` unlocks the vault BEFORE
 * `refreshAuth()` sets `user` — the unlock happens under the transient
 * 'signed-out' provider key. The remounted (real-user-id-keyed) instance
 * starts locked (`isUnlocked: false`, no native key handle): its master key
 * handle was released when the old 'signed-out' instance unmounted.
 * `BiometricGuard`'s "post-login vault unlock" effect (App.tsx) re-unlocks
 * the new instance from the keychain (the key WAS persisted during the
 * original phrase unlock), but it does so fire-and-forget — unawaited by any
 * screen. A fast verify (a scripted/Maestro run reading the phrase words and
 * submitting in well under a second) can reach
 * `RecoveryPhraseVerifyScreen.handleVerify` before that background unlock
 * resolves.
 *
 * The bug: trusting a stale `isUnlocked` snapshot at that point silently
 * skipped `seedWelcomeMarkdown` entirely — not even attempted, so NOTHING
 * reached Metro, not even a warning. Fix: actively (re)unlock before
 * deciding to skip, and log every outcome.
 */
export async function ensureUnlockedAndSeed(opts: EnsureUnlockedAndSeedOptions): Promise<boolean> {
  const { isUnlocked, unlock, ...seedOpts } = opts;
  if (!isUnlocked) {
    try {
      await unlock();
    } catch (err) {
      console.info('[welcome-seed] seed skipped: vault could not be unlocked', err);
      return false;
    }
  }
  return seedWelcomeMarkdown(seedOpts);
}
