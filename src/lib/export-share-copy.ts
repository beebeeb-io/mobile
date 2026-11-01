/**
 * Task 2253 — stage a decrypted export under its real name for the share
 * sheet.
 *
 * The decrypted plaintext of a preview is cached at
 * `Library/Caches/preview/<fileId>.<ext>`, so `Sharing.shareAsync` used to
 * name the user's saved copy after the file id. This copies the plaintext
 * into
 *
 *     <cache>/beebeeb-export/<random>/<decrypted name>
 *
 * — a fresh per-export folder, so two exports of same-named files never clash
 * and the name stays exact. `beebeeb-export/` is already a registered
 * plaintext leaf (`lib/caches-plaintext-registry.ts`) and is swept on
 * sign-out, so this adds no new on-disk location; the copy itself goes
 * through `gatedPlaintextWrite` so it cannot land after the purge.
 *
 * The caller removes the whole per-export folder when the share sheet
 * resolves (`cleanup()`).
 *
 * Round 2 (mobile#254 review, P1): the name enters the URI PERCENT-ENCODED,
 * and the decoded target must be exactly `<folder>/<name>`. The file-system
 * layer percent-decodes the URI path, so a raw name was path syntax: a
 * shared file called `..%2F..%2Fx` landed outside `beebeeb-export/<random>/`
 * (and outside the leaf the sign-out purge sweeps).
 */
import * as FileSystem from 'expo-file-system/legacy';
import { exportFileName, exportSubdirectoryName } from './export-file-name';
import { gatedPlaintextWrite } from './plaintext-gate';

export interface ExportShareFs {
  cacheDirectory: string | null;
  makeDirectoryAsync: (uri: string, options?: { intermediates?: boolean }) => Promise<void>;
  copyAsync: (options: { from: string; to: string }) => Promise<void>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
  /** Lists the export root for the stale-copy sweep (absent ⇒ no sweep). */
  readDirectoryAsync?: (uri: string) => Promise<string[]>;
}

/**
 * Round 3 (mobile#265 review): a per-export folder this old was left by an
 * export the app did not live to clean up (killed or crashed while the share
 * sheet was open). Every export sweeps them, so decrypted copies do not pile
 * up until sign-out. An export in progress is minutes old at most: the sheet
 * is modal and a new export cannot start while it is open.
 */
export const STALE_EXPORT_FOLDER_MS = 10 * 60 * 1000;

// `exportSubdirectoryName`: `<base36 Date.now()>-<8 hex>`.
const EXPORT_FOLDER_NAME = /^([0-9a-z]+)-[0-9a-f]{8}$/;

async function sweepStaleExportFolders(fs: ExportShareFs, root: string, now: number): Promise<void> {
  if (!fs.readDirectoryAsync) return;
  let names: string[];
  try {
    names = await fs.readDirectoryAsync(root);
  } catch {
    return; // no export root yet
  }
  for (const name of names) {
    const minted = EXPORT_FOLDER_NAME.exec(name);
    // Anything not minted here (a bare copy an older build wrote straight into
    // the root) is a leftover too: nothing else belongs in this leaf.
    const stale = !minted || now - parseInt(minted[1], 36) > STALE_EXPORT_FOLDER_MS;
    if (stale) await fs.deleteAsync(`${root}${encodeURIComponent(name)}`, { idempotent: true }).catch(() => {});
  }
}

/** The registered plaintext export dir (see `CACHES_REGISTRY`). */
export function exportShareRoot(fs: ExportShareFs): string {
  return `${fs.cacheDirectory}beebeeb-export/`;
}

export const PREVIEW_EXPORT_ROOT = exportShareRoot(FileSystem);

export interface ExportShareCopy {
  /** The path handed to `Sharing.shareAsync` — `<folder>/<display name>`. */
  uri: string;
  /** The per-export folder to delete once the sheet closes. */
  folderUri: string;
  cleanup: () => Promise<void>;
}

export interface PrepareExportShareCopyInput {
  /** The decrypted plaintext to hand over (the preview cache file). */
  sourceUri: string;
  /** The decrypted display name; `null`/blank ⇒ the id-based name. */
  displayName: string | null | undefined;
  /** Today's id-based name, used only when no display name is available. */
  idBasedName: string;
  random?: () => number;
  fs?: ExportShareFs;
  now?: () => number;
}

export async function prepareExportShareCopy({
  sourceUri,
  displayName,
  idBasedName,
  random,
  fs = FileSystem,
  now = Date.now,
}: PrepareExportShareCopyInput): Promise<ExportShareCopy> {
  const root = exportShareRoot(fs);
  await sweepStaleExportFolders(fs, root, now());
  const folderUri = `${root}${exportSubdirectoryName(random)}/`;
  const name = exportFileName(displayName, idBasedName);
  const uri = `${folderUri}${encodeURIComponent(name)}`;
  assertExportTargetInsideFolder(uri, folderUri, name);

  const cleanup = async (): Promise<void> => {
    await fs.deleteAsync(folderUri, { idempotent: true }).catch(() => {});
  };

  try {
    await fs.makeDirectoryAsync(folderUri, { intermediates: true });
    // Task 1593 — plaintext writer, gated by the sign-out purge.
    await gatedPlaintextWrite('preview export copy', uri, fs, () =>
      fs.copyAsync({ from: sourceUri, to: uri }),
    );
  } catch (error) {
    // Never leave a plaintext folder behind for a failed export.
    await cleanup();
    throw error;
  }

  return { uri, folderUri, cleanup };
}

/** The path a `file://` URI names, decoded as the file-system layer decodes it. */
export function decodedFileUriPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/**
 * Round 2 (mobile#254 review, P1): the decoded target is exactly
 * `<decoded folder>/<name>`, and `name` is one path component. Throws before
 * anything is written otherwise.
 */
export function assertExportTargetInsideFolder(uri: string, folderUri: string, name: string): void {
  const folderPath = decodedFileUriPath(folderUri);
  const targetPath = decodedFileUriPath(uri);
  const oneComponent = name.length > 0 && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\');
  if (!oneComponent || !folderPath.endsWith('/') || targetPath !== `${folderPath}${name}`) {
    throw new Error('Export name does not stay inside its export folder');
  }
}
