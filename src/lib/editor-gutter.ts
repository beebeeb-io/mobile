/**
 * editor-gutter — pure line / row math for TextEditorView's line-number
 * gutter (task 1578, Issue 3: "when i add a new line i see the line nr from
 * above but not current … i see 20 on the left but not 21 on the line that
 * i'm at").
 *
 * Analysed cause (from the code; the on-device repro is Guus's report, not
 * yet a simulator capture — see task 1578 Notes): the logical line COUNT was already
 * right (`text.split('\n').length` counts a trailing empty line — "a\n" is
 * 2). What was wrong is WHERE each number was drawn. The gutter stacked one
 * fixed `LINE_HEIGHT` row per logical line, while the TextInput soft-wraps
 * every line longer than its width (RN's multiline TextInput cannot turn
 * wrapping off). Markdown prose wraps constantly, so every wrapped line
 * above the caret pushed the text further down than the gutter: after a
 * return on line 20, the text's line 21 sat several rows below gutter row
 * 21, the row beside the caret was blank or showed a smaller number, and
 * near the end of the file `clampGutterOffset` (computed from the too-short
 * unwrapped height) pinned the last numbers above the caret line.
 *
 * The fix measures how many visual rows each logical line occupies at the
 * editor's real text width (a hidden, identically-styled Text per line in
 * TextEditorView) and gives each gutter row that height, so number N always
 * sits at the top of logical line N — the same model CodeMirror / Xcode use.
 * This module is the pure part: splitting, counting, and row geometry.
 */

/**
 * Split editor text into logical lines, exactly as the native text view
 * breaks paragraphs: `\r\n` is ONE break (not two), and a lone `\r` or `\n`
 * is one break each. A trailing break yields a trailing empty line — that
 * empty line is where the caret sits after pressing return at the end of
 * the text, so it must get its own number.
 */
export function splitLogicalLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Number of logical lines; never less than 1 (an empty file has line 1). */
export function countLogicalLines(text: string): number {
  return splitLogicalLines(text).length;
}

/**
 * Normalise one measured wrap count. Unmeasured (not laid out yet, or past
 * the measuring cap), zero (RN reports 0 lines for an empty string), NaN or
 * negative all mean "one row" — every logical line occupies at least one
 * visual row in the text view.
 */
export function normalizeWrapCount(n: number | undefined | null): number {
  if (n == null || !Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export interface GutterRow {
  /** 1-based logical line number shown in the gutter. */
  lineNumber: number;
  /** Visual rows this logical line occupies (1 + its soft wraps). */
  rows: number;
  /** Row height in points (`rows * lineHeight`). */
  height: number;
  /** Top of this row, relative to the top of the first line. */
  top: number;
}

export interface GutterLayout {
  rows: GutterRow[];
  /** Sum of all visual rows — the text's real wrapped line count. */
  visualRowCount: number;
  /** `visualRowCount * lineHeight` — the text's real content height (sans padding). */
  totalHeight: number;
}

/**
 * Row geometry for the given logical lines, using each line's measured wrap
 * count looked up BY ITS TEXT (the editor's text width is fixed while
 * measuring, so equal text wraps identically). Keying by text rather than
 * by index means pressing return mid-file does not invalidate every line
 * below it: shifted lines keep their known counts and only the one new or
 * changed line waits for a measurement (counted as one row until it lands).
 * Number N's top equals the top of logical line N in the text view, so a
 * wrapped line above never shifts the numbers below it out of alignment.
 */
export function computeGutterLayout(
  lines: ReadonlyArray<string>,
  wrapsByText: ReadonlyMap<string, number>,
  lineHeight: number,
): GutterLayout {
  const count = Math.max(1, lines.length);
  const rows: GutterRow[] = new Array(count);
  let top = 0;
  let visualRowCount = 0;
  for (let i = 0; i < count; i++) {
    const text = lines[i];
    const r = normalizeWrapCount(text === undefined ? undefined : wrapsByText.get(text));
    const height = r * lineHeight;
    rows[i] = { lineNumber: i + 1, rows: r, height, top };
    top += height;
    visualRowCount += r;
  }
  return { rows, visualRowCount, totalHeight: top };
}

/**
 * Record one measurement, returning the SAME map when nothing changed so a
 * React state setter bails out of a re-render.
 */
export function withWrapCount(
  prev: ReadonlyMap<string, number>,
  text: string,
  wraps: number,
): ReadonlyMap<string, number> {
  const value = normalizeWrapCount(wraps);
  if (prev.get(text) === value) return prev;
  const next = new Map(prev);
  next.set(text, value);
  return next;
}

/**
 * Drop cached counts for texts that are no longer lines of the document
 * (PR #132 review). Each edit mounts a new line version under a new text key;
 * without pruning, every intermediate version stays in the cache for the
 * whole session and every `withWrapCount` clone grows with it. O(keep +
 * cache). Returns the SAME map when nothing is dropped, so a React state
 * setter still bails out. After this call the cache holds at most the
 * distinct texts in `keep`.
 */
export function retainWrapCounts(
  prev: ReadonlyMap<string, number>,
  keep: ReadonlyArray<string>,
): ReadonlyMap<string, number> {
  const live = new Set(keep);
  let stale = false;
  for (const k of prev.keys()) {
    if (!live.has(k)) {
      stale = true;
      break;
    }
  }
  if (!stale) return prev;
  const next = new Map<string, number>();
  for (const [k, v] of prev) if (live.has(k)) next.set(k, v);
  return next;
}

/**
 * Distinct line texts to measure, in first-seen order, capped at `max` so a
 * pathological file cannot mount an unbounded number of hidden Text nodes
 * (lines past the cap simply fall back to one row — the pre-1578 model).
 */
export function uniqueLinesToMeasure(lines: ReadonlyArray<string>, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}
