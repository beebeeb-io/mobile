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

**Design:** `design/preview-redesign-ios.html` section 01 — "Tap the content
to hide both bars" is described for the frame generally, and section 03
claims "Same frame for every type... only the content area changes."

**What shipped:** `handleContentTap` (toggles `barsVisible`) is wired on:
the PDF Pressable, the text/markdown/code read-view Pressable, and the
media branch's single-file (non-pager) Pressable (covers image + video).
It is deliberately NOT wired on: the `isSvg`/`isHtml` WebView branches, the
DOCX/XLSX/PPTX/ZIP/Archive renderer branches, the multi-photo `FlatList`
pager (`PhotoPage.tsx`), or the generic/error/fallback card.

**Why:**
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
- Fallback card: the design's own section 03 "good" list separates "100%
  of the screen for the file" (full-bleed content) from the card pattern —
  a centered card with a Format/Type/Download message is not itself
  full-bleed content in any of the mockups, so there is nothing here for a
  tap to reveal/hide additional pixels of.

**Follow-up:** a dedicated small task per surface (read `PhotoPage.tsx`
first for the pager; confirm 1564 has merged before touching the SVG/HTML/
DOCX branches) would close this gap without the same risk, once done in
isolation with its own on-device gesture verification.

## Task 1563 follow-up (preview redesign) — ⋯ menu is missing "Move to…"

**Design:** section 02's ⋯ menu mock lists `Edit / Show source / Copy share
link / Move to… / Version history / Move to Trash`.

**What shipped:** `Edit` (existing), `Show Source`/`Show Preview` (new,
markdown only), `Share Beebeeb Link` (existing — same action as the mock's
"Copy share link", not relabeled), `Save Original…` (existing), `Copy File
Name` (existing, not in the mock), `Duplicate` (existing, not in the mock),
`Move to Trash` (existing). "Version history" is not a separate menu item —
it opens the same Info sheet the bottom bar's "Versions" button does (the
sheet's own Versions section, item 5). **No "Move to…" item.**

**Why:** there is no existing folder-picker flow in this screen or a
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
