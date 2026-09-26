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
