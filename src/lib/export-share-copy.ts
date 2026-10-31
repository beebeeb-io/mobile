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
}

export async function prepareExportShareCopy({
  sourceUri,
  displayName,
  idBasedName,
  random,
  fs = FileSystem,
}: PrepareExportShareCopyInput): Promise<ExportShareCopy> {
  const root = exportShareRoot(fs);
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
