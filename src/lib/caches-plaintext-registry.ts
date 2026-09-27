/**
 * Task 1593 (round 2, #141 re-review P2-E) — the ONE list of what this app
 * writes into `Library/Caches/` (expo `FileSystem.cacheDirectory`), and the
 * purge that removes every entry holding user plaintext.
 *
 * Why a JS registry: the native plaintext registry
 * (`modules/beebeeb-crypto/ios/PlaintextStorageProtection.swift`) covers the
 * backed-up containers and deliberately excludes `Library/Caches/`, on the
 * assumption that iOS evicts caches. It does, but not on sign-out: until
 * round 2 of task 1593 the decrypted photo cache, "Save to Files" copies,
 * shared-link decrypts, pre-upload photo copies and more stayed on disk for
 * whoever signed in next.
 *
 * Every writer into the caches directory MUST have an entry here — either
 * `plaintext: true` (swept by `purgeCachesPlaintext()` on sign-out / signed-out
 * launch) or `plaintext: false` with the reason it holds no user plaintext.
 * `caches-plaintext-registry.test.ts` scans the source for every
 * `${FileSystem.cacheDirectory}…` / `${cacheDir}…` path and fails when its
 * literal name prefix matches no entry here — so a new writer cannot land
 * without being registered.
 */
import * as FileSystem from 'expo-file-system/legacy';

export interface CachesEntry {
  /** A directory name (ends in `/`), a name prefix, or a name pattern. */
  match: string | RegExp;
  plaintext: boolean;
  contains: string;
  writer: string;
}

// A file id (UUID) — the legacy PreviewScreen download copy was `<id>_<name>`.
const LEGACY_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i;

export const CACHES_REGISTRY: readonly CachesEntry[] = [
  { match: 'preview/', plaintext: true, contains: 'decrypted file previews + RAW embedded JPEGs', writer: 'lib/native-decrypt.ts, lib/raw-extract.ts' },
  { match: 'beebeeb-photo-cache/', plaintext: true, contains: 'decrypted photo/video originals (Photos pager)', writer: 'lib/photo-cache.ts' },
  { match: 'zip-extract/', plaintext: true, contains: 'a file extracted from a decrypted ZIP for the share sheet', writer: 'components/preview/ZipRenderer.tsx' },
  { match: 'beebeeb-export/', plaintext: true, contains: '"Save to Files" copy under the real file name', writer: 'screens/FilesScreen.tsx saveToFiles' },
  { match: 'shared_', plaintext: true, contains: 'a decrypted shared-link file', writer: 'screens/SharedViewScreen.tsx (lib/share-file-name.ts)' },
  { match: 'thumb_', plaintext: true, contains: 'thumb_source_*: decrypted original for thumbnail repair; thumb_<id>.jpg: legacy decrypted thumbnails', writer: 'lib/thumbnail.ts' },
  { match: 'upload-', plaintext: true, contains: 'pre-encryption copy of a picked photo/video', writer: 'screens/FilesScreen.tsx copyPhotoAssetToUploadCache' },
  { match: 'new-', plaintext: true, contains: 'pre-encryption content of a new text file', writer: 'screens/FilesScreen.tsx writeTempFile' },
  { match: 'beebeeb-photos-', plaintext: true, contains: 'decrypted photos zipped for the share sheet', writer: 'screens/PhotosScreen.tsx' },
  { match: 'beebeeb-scan-', plaintext: true, contains: 'scanned-document PDF before encryption', writer: 'screens/DocumentScannerScreen.tsx' },
  { match: 'beebeeb-data-export-', plaintext: true, contains: 'the account data export ZIP', writer: 'screens/PrivacyScreen.tsx' },
  { match: 'beebeeb-proof-', plaintext: true, contains: 'proof-of-existence text incl. the file name', writer: 'screens/FilesScreen.tsx ProofSheet' },
  { match: 'device_manifest_', plaintext: true, contains: 'backup device manifest JSON before encryption', writer: 'services/BackupService.ts' },
  { match: LEGACY_ID_PREFIX, plaintext: true, contains: 'legacy <fileId>_<name> preview download copy (older builds)', writer: 'screens/PreviewScreen.tsx (stale-copy cleanup only)' },
  { match: 'beebeeb-welcome-', plaintext: false, contains: 'the built-in public welcome note (same text for every user)', writer: 'lib/welcome-seed.ts' },
  { match: 'beebeeb-upload-', plaintext: false, contains: 'an ENCRYPTED chunk awaiting PUT', writer: 'lib/api.ts putBinaryBytes' },
  { match: 'beebeeb-transfer/', plaintext: true, contains: "received transfer blob (user-key ciphertext) under the sender's plaintext file-name hint", writer: 'screens/ConstellationScannerScreen.tsx' },
  { match: /\.beebeeb\.enc$/, plaintext: true, contains: 'downloaded ciphertext ("Prove it" export) under the plaintext file name — never deleted by its writer', writer: 'components/EncryptionProof.tsx' },
  { match: 'beebeeb-plaintext-audit.json', plaintext: false, contains: 'path/attribute audit — no user content', writer: 'native PlaintextStorageProtection.writeAuditReport' },
];

function entryMatches(entry: CachesEntry, name: string): boolean {
  if (entry.match instanceof RegExp) return entry.match.test(name);
  if (entry.match.endsWith('/')) return name === entry.match.slice(0, -1) || name === entry.match;
  return name.startsWith(entry.match);
}

/** The registry entry a top-level `Library/Caches/` name belongs to, if any. */
export function cachesEntryFor(name: string): CachesEntry | null {
  return CACHES_REGISTRY.find((entry) => entryMatches(entry, name)) ?? null;
}

/** True when a top-level `Library/Caches/` name holds user plaintext. */
export function isCachesPlaintextName(name: string): boolean {
  return cachesEntryFor(name)?.plaintext === true;
}

export interface CachesFs {
  cacheDirectory: string | null;
  readDirectoryAsync: (uri: string) => Promise<string[]>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

/**
 * Delete every top-level `Library/Caches/` entry the registry marks as
 * plaintext. Everything else there (system/framework caches, ciphertext) is
 * left alone. Never throws; returns the names it removed.
 */
export async function purgeCachesPlaintext(fs: CachesFs = FileSystem): Promise<string[]> {
  const dir = fs.cacheDirectory;
  if (!dir) return [];
  let names: string[];
  try {
    names = await fs.readDirectoryAsync(dir);
  } catch {
    return [];
  }
  const doomed = names.filter(isCachesPlaintextName);
  await Promise.all(
    doomed.map((name) => fs.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => {})),
  );
  return doomed;
}
