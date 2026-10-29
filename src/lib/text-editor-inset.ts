/**
 * text-editor-inset — pure padding math for TextEditorView's TextInput +
 * line-number gutter (build 217 bug: "edit mode text hidden under the
 * floating Done/title/Save bar, and not scrollable").
 *
 * TextEditorView's TextInput has no wrapping ScrollView — a multiline
 * TextInput scrolls itself, and on iOS RN maps the TextInput's own
 * `padding`/`paddingTop` style to the underlying UITextView's
 * `textContainerInset`, which insets the text WITHIN the scrollable content
 * (exactly like a ScrollView's `contentContainerStyle` padding — it scrolls
 * away with the content) rather than a fixed viewport inset. This is the
 * SAME mechanism `bottomInset` already relies on in this component (see
 * `TextEditorView`'s own `bottomInset` doc comment, verified on-device) —
 * this module just gives the top side the same treatment, mirroring
 * `computePreviewContentInset` (CodeRenderer's read-only sibling: additive
 * to the editor's own baseline breathing room rather than replacing it, so
 * the existing "some space above line 1" feel survives).
 *
 * Before this fix, the TextInput and gutter had a bare, hardcoded 12pt top
 * padding with no allowance for the floating header — at rest, line 1 sat
 * UNDER the header, and because the un-padded content was often shorter
 * than the viewport, there was nothing to scroll (the reported "no
 * scrolling" symptom is a direct consequence of the missing padding, not a
 * separate bug: once padding pushes total content height past the viewport,
 * the TextInput scrolls natively).
 *
 * The line-number gutter is a separate absolutely-clipped column synced to
 * the TextInput's scroll via `onScroll` + a `translateY` transform — it
 * needs the SAME top padding as the TextInput or line numbers drift out of
 * alignment with their lines the moment a non-zero topInset is introduced.
 */

export const EDITOR_BASE_TOP_PADDING = 12;
export const EDITOR_BASE_BOTTOM_PADDING = 32;

export interface EditorContentPadding {
  /** Applied to BOTH the TextInput's own top padding and the gutter's
   * `paddingTop`, so line numbers stay pixel-aligned with their lines. */
  paddingTop: number;
  paddingBottom: number;
}

/**
 * `topInset`/`bottomInset` are the floating chrome's own real height (e.g.
 * `computePreviewContentInset(...).top`, the header's measured height +
 * safe area + gap). Never negative in practice, but clamped defensively the
 * same way `computePreviewContentInset` clamps its own inputs; `undefined`/
 * `null`/non-positive treated as "no inset" (falls back to the bare base
 * padding, same as before this fix).
 */
export function computeEditorContentPadding(
  topInset?: number | null,
  bottomInset?: number | null,
): EditorContentPadding {
  const top = topInset != null && topInset > 0 ? topInset : 0;
  const bottom = bottomInset != null && bottomInset > 0 ? bottomInset : 0;
  return {
    paddingTop: EDITOR_BASE_TOP_PADDING + top,
    paddingBottom: EDITOR_BASE_BOTTOM_PADDING + bottom,
  };
}

/**
 * Regression found verifying THIS fix on a real ≥150-line file (task 1575,
 * not build 217's original bug — a separate defect this fix's own testing
 * uncovered): the line-number gutter is a fixed `lineCount * LINE_HEIGHT`
 * column synced to the TextInput's real scroll via a `translateY` transform.
 * The TextInput's REAL scrollable height is taller than that whenever any
 * source line soft-wraps (already documented as a "drift" limitation in
 * TextEditorView's own doc comment) — but once the real `contentOffset.y`
 * exceeds the gutter's own (smaller, un-wrapped) total height, the transform
 * pushes EVERY gutter number above the clipped viewport's top edge at once:
 * not drift, a fully BLANK gutter (reproduced on-device, `scrollY=4218` vs.
 * a ~177-line gutter whose un-wrapped content tops out around 3550 — see the
 * task file's Notes for the full repro). This clamps the gutter's own
 * transform to its own content bounds so it can never scroll further than
 * its last line, exactly like a shorter independent scroll view would if it
 * were one — the numbers stop advancing 1:1 with a wrapped TextInput past
 * that point (still the pre-existing, disclosed drift limitation), but they
 * stay VISIBLE and pinned at the bottom rather than vanishing.
 */
export function clampGutterOffset(
  rawOffset: number,
  lineCount: number,
  lineHeight: number,
  topPadding: number,
  bottomPadding: number,
  viewportHeight: number,
): number {
  // The TextInput's scrollable content is `topPadding + lines + bottomPadding`
  // (both paddings are textContainerInset — they scroll with the content), so
  // its max contentOffset.y is that total minus the viewport. The gutter must
  // reach the SAME max or, at the very end of a file, the text keeps moving
  // up through the bottom padding while the gutter stops — the last number
  // sits `bottomPadding` below its line (PR #131 review, Codex P2).
  const gutterContentHeight =
    Math.max(0, lineCount) * lineHeight + topPadding + Math.max(0, bottomPadding);
  const maxOffset = Math.max(0, gutterContentHeight - viewportHeight);
  return Math.max(0, Math.min(rawOffset, maxOffset));
}
