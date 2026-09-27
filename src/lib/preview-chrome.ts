/**
 * preview-chrome — pure helpers for the Preview screen's redesigned frame
 * (task 1563 follow-up, "preview redesign", `design/preview-redesign-ios.html`).
 *
 * Kept dependency-free (no React Native, no navigation) so these can be unit
 * tested directly, the same pattern as `text-edit-gate.ts` / `editor-key-actions.ts`.
 */

export interface BarsTapContext {
  /** No bars exist to toggle while editing (item 7: "no bottom bar while
   * editing", and the top bar is replaced by the Done/Save row). */
  editMode: boolean;
  /** A tap while the Info sheet is open closes the sheet, not the bars
   * underneath it. */
  infoVisible: boolean;
  /** Same for the ⋯ options popover. */
  optionsVisible: boolean;
}

/**
 * Whether a tap on the content area should toggle the top/bottom bars
 * (design item 4: "Tap content toggles both bars").
 */
export function shouldToggleBarsOnTap(ctx: BarsTapContext): boolean {
  return !ctx.editMode && !ctx.infoVisible && !ctx.optionsVisible;
}

/** The next `barsVisible` value after a content tap, given the current one. */
export function nextBarsVisible(current: boolean, ctx: BarsTapContext): boolean {
  if (!shouldToggleBarsOnTap(ctx)) return current;
  return !current;
}

export interface InfoSublineInput {
  kindLabel: string;
  sizeLabel: string | null;
  /** PDF page count, when known. Any other file type passes `null`/`undefined`. */
  pageCount?: number | null;
}

/**
 * The Info sheet's subline (design section 03: "PDF · 88 KB · 2 pages").
 * The page-count segment only appears for a KNOWN, multi-page document — a
 * still-loading or genuinely single-page file omits it rather than showing
 * a misleading "1 page" or "0 pages".
 */
export function buildInfoSubline(input: InfoSublineInput): string {
  const parts = [input.kindLabel];
  if (input.sizeLabel) parts.push(input.sizeLabel);
  if (input.pageCount != null && input.pageCount > 1) {
    parts.push(`${input.pageCount} pages`);
  }
  return parts.join(' · ');
}

/**
 * The Info sheet's "Shared" row. `shareCount` is the server's `FileEntry.
 * share_count` — `null`/`undefined` (not yet loaded) reads exactly like 0
 * rather than flashing a stale count borrowed from a previously-viewed file.
 */
export function formatShareStatus(shareCount: number | null | undefined): string {
  const count = shareCount ?? 0;
  if (count <= 0) return 'Not shared';
  return `Shared · ${count} link${count === 1 ? '' : 's'}`;
}

/**
 * The Info sheet's "Folder" row. A root-level file (no `parentId`) is always
 * "Home", regardless of whether a name lookup ran. A non-root file shows the
 * resolved name once known, or a loading placeholder before it resolves.
 */
export function resolveFolderLabel(
  parentId: string | null | undefined,
  resolvedName: string | null,
): string {
  if (!parentId) return 'Home';
  return resolvedName ?? 'Loading…';
}

/**
 * The floating page-counter pill (design item 6, PDF; generalized to the
 * photo swipe-pager too — same "N / total" shape). Returns `null` for a
 * single-page/single-item set or one whose count isn't known yet, so the
 * caller renders nothing rather than a degenerate "1 / 1" or "1 / 0".
 */
export function formatPdfPageCounter(current: number, total: number): string | null {
  if (total <= 1) return null;
  return `${current} / ${total}`;
}
