/**
 * One-shot seed of a welcome.md file into a brand-new account.
 *
 * Runs after successful recovery-phrase verification. Encrypted via the
 * existing upload pipeline — the server never sees the plaintext copy.
 *
 * Idempotency is double-guarded:
 *  1. Per-device SecureStore flag (`beebeeb_welcome_seeded:<userId>`). A second
 *     sign-in on the same device short-circuits before we hit the network.
 *  2. Server-side root-folder check. If the user already has any files at root
 *     (e.g. they're signing in from a second device, or restored from a
 *     recovery phrase), we skip the seed entirely so we never spam duplicate
 *     welcome.md files into an established vault.
 *
 * Failures are silent — a missing welcome file is not worth blocking the
 * post-onboarding navigation. Errors are surfaced via console.warn so a
 * verifier running with a debugger attached can see what happened.
 */
import * as FileSystem from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import type { EncryptedData } from '../../modules/beebeeb-crypto';
import { listFiles } from './api';
import { encryptedUpload, generateFileId } from './encrypted-upload';

const SEEDED_KEY_PREFIX = 'beebeeb_welcome_seeded';

export const WELCOME_FILENAME = 'welcome.md';

// Voice rules in `repos/core/brand/README.md`: honest over reassuring, name
// the city (Falkenstein), no flag emojis, no "bank-grade security."
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
  // SecureStore keys must match `[A-Za-z0-9._-]+`. UUIDs already do; this
  // sanitiser is a belt-and-braces guard for any non-UUID user IDs we might
  // see in the future.
  return `${SEEDED_KEY_PREFIX}:${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * Returns true when this device has already attempted (successfully) to seed
 * welcome.md for the given user.
 */
export async function hasWelcomeBeenSeeded(userId: string): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(seedKey(userId));
    return v === 'true';
  } catch {
    return false;
  }
}

async function markSeeded(userId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(seedKey(userId), 'true');
  } catch {
    // Non-fatal — worst case the seed runs once more on a future sign-in
    // and the "root is non-empty" guard catches it.
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
    if (await hasWelcomeBeenSeeded(userId)) return false;

    // Server-side guard: if root already has files (second device, restore
    // from recovery phrase, etc), don't seed.
    let existing;
    try {
      existing = await listFiles(undefined, false);
    } catch (err) {
      console.warn('[welcome-seed] could not list root files, skipping seed', err);
      return false;
    }
    if (existing.length > 0) {
      await markSeeded(userId);
      return false;
    }

    // Write the markdown to a temp file the upload pipeline can read.
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) {
      console.warn('[welcome-seed] no cache directory available, skipping seed');
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
    console.warn('[welcome-seed] seed failed', err);
    return false;
  }
}
