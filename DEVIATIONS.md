# Deviations from design

Per the workspace `CLAUDE.md` → "How we work" → "Design before code": where a
design artefact and the shipped code disagree, the deviation is recorded HERE,
in the same commit as the code, with the ruling that caused it.

This file did not exist before task 1563 (mobile) — several earlier PreviewScreen.tsx
comments reference "DEVIATIONS.md" for phases 3/4 of the doc-header/light-mode work,
but no such file was ever actually committed in this repo. Created here per the
workspace CLAUDE.md's convention (`repos/mobile DEVIATIONS.md`, as instantiated in
this repo for the first time); the earlier phase 3/4 references remain undocumented
and are out of scope for this task.

## Task 1563 (mobile) — ⋯ menu replaces the Edit/Preview segmented control

**Design:** `design/editor-1563.html`, screen 05 "IPHONE" — shows a segmented
`Edit | Preview` control (`.psegw`/`.pseg`) directly under the header, with the
active mode highlighted.

**Ruling (Guus, verbatim, 2026-09-26 18:50, from build 215's screenshots):**
> "Though markdown does include some coloring but not like how you parse
> markdown typically. I want both options. So at edit its just regular like
> now and preview should really show a preview of it. And then at the 3 dots
> i can change to edit"

**What shipped instead:** no segmented control. A `.md` file opens straight
into the rendered preview (native components, not the old raw-highlighted
view). The existing header **⋯** menu gets one extra item: "Edit" when not
editing, flipping to "Preview" (markdown) or "Done" (plain text/code) while
editing. `.txt` and code files keep opening in the existing highlighted read
view, with the same "Edit" entry point.

**Why:** Guus's ruling is dated AFTER the design mockup and explicitly
supersedes it (precedent: task 1357, "a verbal ruling from Guus supersedes
the artefact"). Recorded here per that same rule ("record it in the task
file verbatim and in DEVIATIONS.md").

## Task 1563 (mobile) — conflict dialog: "Discard my changes" instead of "Show all differences"

**Design:** `design/editor-1563.html`, screen 04 "SAVE" — the web conflict
dialog offers `Show all differences` / `Keep both` / `Save as version N`.

**What shipped on mobile:** `Keep both` / `Save as new version` / `Discard my
changes` (a plain `Alert.alert` with those three options plus Cancel) — no
diff view.

**Why:** the mobile task brief (1563, mobile part) explicitly specifies this
exact three-option set for mobile, and no diff/comparison engine exists on
mobile to power "Show all differences" — building one was out of scope for
this task. The web phase (separate, in progress in parallel) is expected to
ship the diff view; mobile's dialog is honest about not having one rather
than shipping a broken or fake "differences" view.

## Task 1563 (mobile) — no live per-token syntax colouring while editing

**Design:** implied by the mockup's editor screens (colour-highlighted
source in both the web editor and the iPhone editor screen).

**What shipped:** plain monospace editing (JetBrains Mono, line numbers,
InputAccessoryView key row) — no colour token underlay synced to the live
TextInput.

**Why:** the task brief explicitly allows this as a first step ("plain
monospace editing is acceptable as a first step — say which you shipped").
Keeping a colour overlay pixel-aligned with a live-editing native TextInput
(cursor, IME, autocorrect, selection, soft-wrap) needs a measured
per-character text-layout engine RN doesn't provide for free; shipping an
unreliable visual under this task's time budget would have been worse than
shipping none. See `TextEditorView.tsx`'s doc comment for the full
what-shipped-vs-deferred list (line numbers: shipped with a documented
soft-wrap-drift limitation; undo/redo: a JS-side history stack, since RN's
TextInput has no JS-callable native undo).

## Task 1563 follow-up (preview redesign) — tap-to-hide is scoped to PDF, image, video, and text/markdown/code; not wired for SVG, HTML, DOCX/Office previews, the multi-photo swipe pager, or the generic fallback card

**UPDATE (next pass, head `03c7420` → this pass):** 1564 merged to main
(`beebeeb-io/mobile#124`, `c2b291d`) while this lane was still working, and
this branch rebased cleanly on top of it — the isolation reason below no
longer applies. This pass wired full-bleed + tap-to-hide on **every**
remaining branch: `isSvg`, `isDocx`, `isSpreadsheet` (xlsx), `isHtml`,
`isZip`, `isArchive`, `isPptx`, the multi-photo `FlatList` pager, and the
generic/fallback card (tap-to-hide only for the fallback card — see below).
The original entry is kept below for the record of why it was scoped out
THEN; it is no longer the shipped state.

**Rule preserved from 1564:** a WebView must never have a centering DIRECT
parent. Every WebView-based branch (SVG, DOCX via `DocxRenderer`) got a
`Pressable` **ancestor** for tap-to-hide, with 1564's own non-centering
`flex:1` wrapper (`svgWebViewWrap` / `docxWebViewWrap`) kept as the
WebView's unchanged direct parent — confirmed unbroken by
`PreviewScreen.webview-parent.test.ts` (still 7/7 green on this pass's
head).

**Real regression found and fixed on-device (not assumed):** wrapping the
photo pager's `FlatList` in a `Pressable` (the same pattern used everywhere
else) reliably swallowed every swipe — bisected with a real device repro,
not a guess: with the `Pressable` wrapper, a swipe gesture never advanced
past page 1 (screenshot proof, page counter stuck at "1 / 13"); reverting
to a plain `View` and re-running the identical swipe advanced to "2 / 13"
immediately. Fixed WITHOUT a wrapping `Pressable` at all — raw
`onTouchStart`/`onTouchEnd` handlers directly on the `FlatList`, tracking
touch start position/time and calling `handleContentTap` only for a short,
low-movement gesture (a tap), letting a real swipe pass through untouched.
Both swipe-to-page and tap-to-hide verified working together on the SAME
build afterward (screenshots `17-pager-fixed-p1.png` →
`17b-pager-fixed-p2-swiped.png` → `17c-pager-tap-hide.png`).

**Fallback card:** tap-to-hide wired (a `Pressable` ancestor, default
layout, no style override), but the card's own CENTERED layout is
UNCHANGED — see the original entry below for why the fallback card is not
forced full-bleed. This narrows (does not reverse) that entry: the card
now participates in the tap gesture, but not in the full-bleed frame.

---

**Design:** `design/preview-redesign-ios.html` section 01 — "Tap the content
to hide both bars" is described for the frame generally, and section 03
claims "Same frame for every type... only the content area changes."

**What shipped (superseded by the UPDATE above):** `handleContentTap`
(toggles `barsVisible`) is wired on:
the PDF Pressable, the text/markdown/code read-view Pressable, and the
media branch's single-file (non-pager) Pressable (covers image + video).
It is deliberately NOT wired on: the `isSvg`/`isHtml` WebView branches, the
DOCX/XLSX/PPTX/ZIP/Archive renderer branches, the multi-photo `FlatList`
pager (`PhotoPage.tsx`), or the generic/error/fallback card.

**Why (at the time):**
- SVG/HTML: task 1564 (parallel worktree, `mobile-1564`, uncommitted at the
  time of this work) is actively fixing a blank-WebView bug in these EXACT
  branches (`PreviewScreen.tsx`'s `isSvg` block, `DocxRenderer.tsx`). Adding
  a `Pressable` ancestor there is a second, independent change to the same
  code the founder flagged as a conflict risk — left untouched so the two
  branches merge cleanly (see the task file's Notes for the full conflict
  analysis: 1564's fix wraps each WebView in a plain `flex:1` container
  specifically because `previewArea`'s `justifyContent/alignItems:'center'`
  stops Fabric's WKWebView from painting; this redesign does NOT touch
  `previewArea`'s alignment for the same reason the text editor already
  didn't — see `fullBleedFill`'s style comment — so the two fixes don't
  collide on that shared root cause either).
- Office (DOCX/XLSX/PPTX/ZIP/Archive): no design mock exists for these
  (only PDF, photo/RAW, and markdown/code are shown in the redesign), and
  three of the five (DOCX, ZIP, Archive) render via WebView/native list
  views with their own internal scrolling — adding a tap-to-hide Pressable
  ancestor without on-device testing of each risked a real gesture
  regression for no verified-in-design benefit.
- Multi-photo pager: `PhotoPage.tsx` (not read/modified by this lane) very
  likely owns its own pinch/pan/double-tap-zoom gesture handling for
  full-screen photo viewing. Wrapping each page in an ADDITIONAL tap
  responder without reading and testing that component's existing gesture
  logic risked breaking "keep... gestures... working" (this task's own
  top-line constraint) for the sake of one more surface's tap-to-hide.
  **Turned out to be a real risk, not a hypothetical one — see the UPDATE
  above: PhotoPage.tsx itself has no gestures, but the wrapping Pressable
  broke swipe anyway.**
- Fallback card: the design's own section 03 "good" list separates "100%
  of the screen for the file" (full-bleed content) from the card pattern —
  a centered card with a Format/Type/Download message is not itself
  full-bleed content in any of the mockups, so there is nothing here for a
  tap to reveal/hide additional pixels of.

## Task 1563 follow-up (preview redesign) — ⋯ menu is missing "Move to…"

**UPDATE (next pass, head `03c7420` → this pass): SHIPPED, not missing
anymore.** The claim below ("no existing folder-picker flow ... this lane
found to reuse") was WRONG — left visible per the workspace convention
("when you are wrong, leave the wrong claim visible, write the correction
beneath it") rather than quietly edited away. `FilesScreen.tsx` already has
a full "Move" flow (`FolderPickerModal` component + `buildPickerFolders` +
`moveFile` API call) — this pass found it by reading `FilesScreen.tsx`
directly, reused the SAME `FolderPickerModal` component and the SAME
`moveFile` endpoint, and wrote a smaller, Preview-appropriate folder-tree
fetch (`src/lib/move-picker-folders.ts::collectAllFolders`, unit-tested +
mutation-proven) since Preview has no sync engine to source
`FilesScreen`'s own `sync.allNodes()` cache from, and moves a single FILE
(not a folder), so the descendant-exclusion step `FilesScreen`'s version
needs doesn't apply. "Move to…" now sits in the ⋯ menu (between Duplicate
and Move to Trash, matching the mock's ordering) and opens the same native
folder-picker sheet, verified on-device (screenshot: the ⋯ menu showing
"Move to..." between Duplicate and Move to Trash).

---

**Design:** section 02's ⋯ menu mock lists `Edit / Show source / Copy share
link / Move to… / Version history / Move to Trash`.

**What shipped (superseded by the UPDATE above):** `Edit` (existing), `Show Source`/`Show Preview` (new,
markdown only), `Share Beebeeb Link` (existing — same action as the mock's
"Copy share link", not relabeled), `Save Original…` (existing), `Copy File
Name` (existing, not in the mock), `Duplicate` (existing, not in the mock),
`Move to Trash` (existing). "Version history" is not a separate menu item —
it opens the same Info sheet the bottom bar's "Versions" button does (the
sheet's own Versions section, item 5). **No "Move to…" item.**

**Why (at the time — WRONG, see UPDATE above):** there is no existing folder-picker flow in this screen or a
sibling one this lane found to reuse within this task's time budget, and
building a new folder-picker screen from scratch is a bigger, separate
piece of work than the redesign's own scope (chrome, bars, Info sheet,
markdown/editor integration) — the same "keep scope to what's verified"
call the original 1563 web lane made for "New text file" (see that
Notes entry above).

## Task 1563 follow-up (preview redesign) — the permanent "e2e" pill and `DetailsSheet`'s always-visible collapsed peek are removed, not relocated

**Design:** section 00 ("TODAY") explicitly names both as problems ("the
floating 'e2e' pill... covers the content, and 'e2e' is jargon"; "Details...
takes permanent room at the bottom").

**What shipped:** the encryption state moved into the header subtitle
("Encrypted · Type · size", amber lock icon, item 2) on every file, doc and
media alike. `DetailsSheet.tsx` itself is left in the repo (unused by
`PreviewScreen.tsx` now) rather than deleted, in case another screen adopts
it later — nothing currently imports it outside this file.

**Why:** exactly what the design asked for; recorded here because it is a
deletion of previously-shipped, always-visible chrome, not an addition —
per the workspace CLAUDE.md's "ask before you delete or collapse" spirit,
flagging it explicitly rather than letting a `git diff` be the only record.
