/**
 * Task 2238 (mobile) — a folder "Share link" is an interim SNAPSHOT BUNDLE.
 *
 * Mirror of web's src/lib/folder-bundle.ts. Until shared folders with guest
 * uploads ship (task 2237 phase 1), a link on a folder must not be a
 * `share_type: 'file'` share over the folder's own id: the public web page
 * would try to download a folder and the server answers
 * `400 cannot download a folder`. Instead the folder's whole subtree — every
 * non-trashed FILE below it, as it is right now — becomes ONE
 * `share_type: 'bundle'` share (bundle spec 2026-06-17).
 *
 * Bundles are FLAT and the manifest names each item from its own
 * `name_encrypted`, so the guest page lists the plain file names (a duplicate
 * name in two subfolders is allowed — the item id tells them apart). A path
 * sidecar in the link fragment was considered and dropped: up to 256 sealed
 * paths make the URL long enough for chat apps to cut it off, and this is an
 * interim fix until 2237 phase 1 ships real folder links. This module only
 * does the walk: deterministic order, the subtree, the bundle item cap.
 *
 * Deliberately dependency-free (types + injected callbacks) so the walk is
 * unit-testable in bun without native modules, a network or a vault.
 */

/**
 * The bundle item cap from the bundle spec (BUNDLE_MAX_ITEMS, 0417 D2). The
 * server rejects a create over this and the sheet refuses before it mints
 * anything — a folder over the cap needs a narrower selection, never a
 * silently truncated link.
 */
export const FOLDER_BUNDLE_MAX_ITEMS = 256;

/** The subset of a drive row this walk reads (api.ts `FileEntry` satisfies it). */
export interface FolderBundleNode {
  id: string;
  name_encrypted: string;
  is_folder: boolean;
  is_trashed?: boolean;
}

/** One file that will become a bundle item. */
export interface FolderBundleFile {
  fileId: string;
  /** 0-based bundle position; == index in the returned array. */
  position: number;
  /** Decrypted display name, or null when the name could not be decrypted. */
  name: string | null;
}

export interface FolderBundleScan {
  /** Ordered, non-trashed files in the subtree (at most `maxItems`). */
  files: FolderBundleFile[];
  /**
   * True when the subtree holds MORE files than `maxItems` — the walk stops at
   * the cap, so `files.length === maxItems` in that case. The caller must
   * refuse to mint a link and explain the cap.
   */
  overCap: boolean;
}

export interface FolderBundleOptions {
  /** Bundle item cap; defaults to `FOLDER_BUNDLE_MAX_ITEMS`. */
  maxItems?: number;
  /**
   * Leading segment of every prefix: the shared folder's own display name, so
   * the link reads `Holiday/beach.jpg` rather than leaving a root-level item's
   * path ambiguous. Empty when unknown.
   */
  rootPrefix?: string;
}

export interface FolderBundleDeps {
  /** Children of a folder. Trashed rows are filtered here too, defensively. */
  listChildren: (folderId: string) => Promise<FolderBundleNode[]>;
  /**
   * Decrypted name for one row (folders included — a folder's name is encrypted
   * with its own file key). Returning null means "unreadable": the row is still
   * included, but sorting falls back to its id.
   */
  decryptName: (node: FolderBundleNode) => Promise<string | null>;
}

/**
 * Walk `rootFolderId`'s subtree depth-first and return every non-trashed file
 * in a stable order: children of a folder sorted by decrypted name (falling
 * back to id), files at a level before its subfolders' contents.
 *
 * The order is the bundle's `position` order, so the same folder produces the
 * same link layout twice — which is what makes the link's path payload line up
 * with the manifest (`position` is what the manifest orders and paginates by).
 *
 * The walk STOPS as soon as it has seen `maxItems + 1` files: the caller only
 * needs to know "it fits" or "it does not", and a 50k-file folder must not be
 * enumerated to say so.
 */
export async function collectFolderBundle(
  rootFolderId: string,
  deps: FolderBundleDeps,
  options: FolderBundleOptions = {},
): Promise<FolderBundleScan> {
  const maxItems = options.maxItems ?? FOLDER_BUNDLE_MAX_ITEMS;
  const files: FolderBundleFile[] = [];
  let overCap = false;

  async function walk(folderId: string): Promise<void> {
    if (overCap) return;
    const children = await deps.listChildren(folderId);
    const named = await Promise.all(
      children
        .filter((c) => c.is_trashed !== true)
        .map(async (node) => ({ node, name: await deps.decryptName(node) })),
    );
    named.sort((a, b) => {
      const an = a.name ?? a.node.id;
      const bn = b.name ?? b.node.id;
      return an.localeCompare(bn) || a.node.id.localeCompare(b.node.id);
    });

    for (const { node, name } of named) {
      if (overCap) return;
      if (node.is_folder) {
        await walk(node.id);
        continue;
      }
      if (files.length >= maxItems) {
        overCap = true;
        return;
      }
      files.push({ fileId: node.id, position: files.length, name });
    }
  }

  await walk(rootFolderId);
  return { files, overCap };
}
