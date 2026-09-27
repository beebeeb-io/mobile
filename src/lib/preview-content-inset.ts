/**
 * preview-content-inset — pure helpers for where Preview's document content
 * starts/ends relative to the floating glass top/bottom bars (task 1563,
 * PR #123 round 5, lead review of round 4's own screenshots).
 *
 * Round 4 fixed the "opaque dark band" dead-space bug by making
 * `previewArea` a full-screen absolute layer (so content reaches y=0), but
 * that overcorrected: with NO inset at all, a document's first line now sits
 * literally UNDER the floating top bar (a PDF title colliding with the
 * system clock, a DOCX's first two lines hidden behind the title pill).
 *
 * The required behaviour (Photos/Files/Notion): AT REST, content starts just
 * BELOW the floating bar; when the user SCROLLS, content moves UNDER the
 * translucent bar (the bar floats over it, it doesn't get shoved out of the
 * way). That is exactly what a scroll container's own top/bottom content
 * inset gives you for free — the viewport still spans the whole screen, only
 * the CONTENT gets extra padding — so this module computes that inset, it
 * doesn't move where anything is drawn.
 *
 * Kept dependency-free (no React Native) so it's unit-testable directly, the
 * same pattern as `preview-chrome.ts` / `text-edit-gate.ts`.
 */

/** Extra breathing room below the top bar's own bottom edge before content
 * starts — matches the brief's "~8pt" and the identical gap the bottom bar
 * already bakes into its own screen offset (see `PREVIEW_BOTTOM_BAR_GAP`
 * below), so both edges read as the same visual rhythm. */
export const PREVIEW_CONTENT_TOP_GAP = 8;

/**
 * Fallback "bar height" (the header row's own content + padding, NOT
 * including the safe-area top inset) for the one render frame before the
 * header's real height is measured via `onLayout`. Not a guess: this is the
 * same `58` PreviewScreen.tsx already uses (and has verified on-device,
 * rounds 3/4) as "just under the header" for the PDF page-counter pill and
 * the ⋯ options popover anchor — see `insets.top + 58` at both call sites.
 */
export const PREVIEW_HEADER_HEIGHT_FALLBACK = 58;

/**
 * Fallback bottom-bar height (PreviewBottomBar's own rendered height, not
 * including its offset from the screen's bottom edge) for the one frame
 * before it is measured. Derived from its own fixed style, not eyeballed:
 * `barContent` paddingVertical 10 (×2) + an action item's icon (22) + gap
 * (3) + label line (~13) + the item's own paddingVertical 2 (×2) ≈ 62.
 */
export const PREVIEW_BOTTOM_BAR_HEIGHT_FALLBACK = 62;

/** The bottom bar's own gap from the safe area (mirrors `bottomBarWrap`'s
 * `bottom: Math.max(insets.bottom, 16) + 8` at its JSX call site) — content's
 * bottom inset reuses the SAME number so the last visible line ends exactly
 * where the bar begins, not short of it or overlapping it. */
export const PREVIEW_BOTTOM_BAR_GAP = 8;
export const PREVIEW_BOTTOM_BAR_MIN_SAFE_AREA = 16;

export interface PreviewContentInsetInput {
  /** `useSafeAreaInsets().top` — the status bar / notch inset. */
  safeAreaTop: number;
  /** `useSafeAreaInsets().bottom` — the home-indicator inset. */
  safeAreaBottom: number;
  /**
   * The floating top bar's own measured height (`onLayout` on the wrapper
   * that starts at screen y=0), which already bakes in `safeAreaTop` via the
   * header's own `paddingTop`. `null`/`undefined` (not measured yet) falls
   * back to `safeAreaTop + PREVIEW_HEADER_HEIGHT_FALLBACK`.
   */
  headerHeight?: number | null;
  /**
   * The floating bottom bar's own measured height (NOT including its offset
   * from the screen edge). `null`/`undefined` falls back to
   * `PREVIEW_BOTTOM_BAR_HEIGHT_FALLBACK`.
   */
  bottomBarHeight?: number | null;
}

export interface PreviewContentInset {
  top: number;
  bottom: number;
}

/**
 * Content inset top = safe-area top + bar height + ~8pt.
 * Content inset bottom = bottom bar height + safe-area bottom (+ the bar's
 * own existing gap off the safe area, so the two ends match).
 */
export function computePreviewContentInset(
  input: PreviewContentInsetInput,
): PreviewContentInset {
  const safeAreaTop = Math.max(0, input.safeAreaTop);
  const safeAreaBottom = Math.max(0, input.safeAreaBottom);

  const headerHeight =
    input.headerHeight != null && input.headerHeight > 0
      ? input.headerHeight
      : safeAreaTop + PREVIEW_HEADER_HEIGHT_FALLBACK;

  const bottomBarHeight =
    input.bottomBarHeight != null && input.bottomBarHeight > 0
      ? input.bottomBarHeight
      : PREVIEW_BOTTOM_BAR_HEIGHT_FALLBACK;

  const bottomBarScreenGap =
    Math.max(safeAreaBottom, PREVIEW_BOTTOM_BAR_MIN_SAFE_AREA) + PREVIEW_BOTTOM_BAR_GAP;

  return {
    top: Math.round(headerHeight + PREVIEW_CONTENT_TOP_GAP),
    bottom: Math.round(bottomBarHeight + bottomBarScreenGap),
  };
}
