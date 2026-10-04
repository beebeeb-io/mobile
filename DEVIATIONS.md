# Deviations from design

Per the workspace `CLAUDE.md` → "How we work" → "Design before code": where a
design artefact and the shipped code disagree, the deviation is recorded HERE,
in the same commit as the code, with the ruling that caused it.

## Task 1724 — native video controls reserve space below Preview's floating bottom bar

**Design:** `design/preview-redesign-ios.html` section 01 treats photo/video
media as full-bleed content with floating top and bottom chrome.

**What shipped:** video previews still use the same black full-bleed stage,
but the native `VideoView` itself is inset at the bottom by Preview's floating
bottom bar clearance. This applies to the single-file media branch, the
document-style video branch, and video pages inside the photo/video pager.

**Why:** on iOS, `expo-video` draws the native transport controls inside the
`VideoView` bounds. With the view occupying the whole screen, the playhead sat
directly behind Preview's own Share/Save/Versions/Info bar. Tapping to reveal
chrome also revealed the native controls, so both bars competed for the same
touch area. Reserving the control clearance keeps the native playhead tappable
while preserving the black media ground behind the floating chrome.

## Task 1724 — File Provider known-empty folders and pager preview leases

**Design:** Files should enumerate cached File Provider folders immediately
while refreshing in the background, and preview plaintext cache ownership must
flow through `releasePreviewCopy`.

**What shipped:** an empty cached File Provider folder that already has a
`container.<id>.anchor` now enumerates `[]` immediately and refreshes in the
background. The cold, anchor-less case still waits for a typed refresh outcome.
Photo pager pages now release the preview copy lease they render directly for
RAW source files and loopback video streams when the page unloads or unmounts.

**Why:** rows alone cannot distinguish "never synced" from "synced and empty".
The anchor is the cache's durable synchronized marker. For Preview, deleting a
RAW temp URI directly or clearing a loopback URI left the `decryptToTempFile`
lease live, so purge/account cleanup could see stale ownership.

## Task 1723 PR163 CI — slow native SQLite harness gets a longer test budget only

**Design:** no product design change. This is a CI-only repair for the Swift
compile gate.

**Ruling (Codex, 2026-10-04):** keep the File Provider reset behavior
unchanged. The harness intentionally holds SQLite exclusive locks and executes
two busy-timeout reset attempts; on GitHub's macOS runner, compiling and
running that native harness exceeded the previous 20 second Bun test budget.
The fix is to lengthen that one harness timeout, not relax the assertions or
change product SQLite behavior.

This file did not exist before task 1563 (mobile) — several earlier PreviewScreen.tsx
comments reference "DEVIATIONS.md" for phases 3/4 of the doc-header/light-mode work,
but no such file was ever actually committed in this repo. Created here per the
workspace CLAUDE.md's convention (`repos/mobile DEVIATIONS.md`, as instantiated in
this repo for the first time); the earlier phase 3/4 references remain undocumented
and are out of scope for this task.

## Task 1724 iOS progressive video streaming

**Design / security contract:** Native iOS video preview should match Android
PR 162's progressive model: fetch encrypted `/chunks/{index}` blobs directly,
authenticate/decrypt each chunk with the existing opaque `MasterKeyHandle`, and
serve only verified plaintext bytes from a loopback Range server. The player may
start after chunk 0 and the final chunk are verified, while the remaining chunks
continue buffering in the background.

**Local implementation boundary:** This slice adds the iOS streaming engine as a
new native helper and intentionally does not wire `BeebeebCryptoModule.swift`,
because another native lane owns the Expo bridge in task 1724. The bridge must
call `NativeVideoStreamer.start(...)`, register cancellation through
`NativeVideoStreamer.cancel(requestId:)`, expose
`NativeVideoStreamer.cancel(streamId:)`, and call
`NativeVideoStreamer.cancelAll()` before/inside plaintext purge and account
switch flows.

**Safety invariants:** stream URLs contain a random 128-bit capability segment,
the server uses Apple's Network framework and accepts only loopback peers,
partial sparse files stay under a `.streaming` path instead of the final preview
cache path, cache promotion happens only after every chunk has been
authenticated, and cancellation/account purge closes connections and deletes
partials before another account can write or serve stale plaintext.

## Task 1723 CI-only native Swift harness routing

**Design / CI contract:** Ubuntu `unit-tests` owns portable source guards and
the count-shaped `isolated: N pass, 0 fail across F files` gate. The macOS
`swift-gate` job owns native Swift compilation/runtime harnesses because Linux
CI has no Swift/iOS frameworks.

**What shipped:** the File Provider source guards still run in the Ubuntu unit
suite. The four native Swift runtime harnesses embedded in
`file-provider-purge-hygiene.test.ts` and
`file-provider-enumerator-initial-refresh.test.ts` are explicitly macOS-only in
those files and are required in the existing macOS `swift-gate` job with
`BB_REQUIRE_NATIVE_SWIFT_HARNESSES=1`.

**Why:** PR 163 introduced hostless Swift harnesses into the Bun unit suite.
They were valid coverage, but running them unconditionally in Ubuntu made the
portable unit job red for host/toolchain reasons rather than product reasons.
This keeps source guards on every platform and moves the runtime Swift proof to
the job that can actually compile and run it, without silently dropping the
coverage.

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

## Task 1563 round 4 (mobile) — Preview's floating chrome no longer follows the app's light/dark theme

**Design:** `design/preview-redesign-ios.html`'s `.glass` rule is a single,
fixed dark-tinted material — every phone mock in that file uses the same
look, none of them vary it by light/dark scheme.

**Prior ruling (task 1344/1346, corrected in place in `PreviewScreen.tsx` —
see the `docMaterial` comment marked "CORRECTION, round 4"):** the doc/PDF
header was switched from a forced-dark material to `glassMaterial(resolved)`
(follow the app's own theme), reasoned from "a document page is usually a
white sheet... forcing dark glass would float a mismatched dark bar over an
otherwise light screen." That reasoning is right for `DocxRenderer`/
`XlsxRenderer`/markdown/code, which DO paint a themed background — but wrong
for a PDF's own bytes, which render a literal (usually white) page
regardless of the app's theme.

**What the lead's round-3 review found:** on a device in dark mode, opening
a PDF put `glassMaterial('dark')`'s 0.46-alpha fill over a white page —
`evidence-1563-redesign-r3/23-pdf-counter-1of4-FIXED.png` shows the result:
a washed-out grey bar with near-invisible labels, ~3.7:1 contrast (below
WCAG AA's 4.5:1), reproduced in `src/lib/contrast.test.ts`.

**What shipped:** a new, single, content-adaptive-safe material
(`PREVIEW_CHROME_MATERIAL`, `glass-recipe.ts`) — a much more opaque
(0.90-alpha) near-black fill plus a real border — used for EVERY floating
control on the Preview screen (both the doc/PDF branch, corrected here, and
the media/image/video branch, which had the identical latent bug: forcing
`scheme="dark"` alone does not fix a washed-out bar over a bright ground,
since `glassMaterial('dark')`'s fill is only 46% opaque either way). This is
now ONE fixed look for Preview's chrome, matching the design's own choice
not to vary it by scheme — verified over a white PDF page, a dark markdown
background, and colourful image/video content, and measured (not just
eyeballed) against white/black/mid-grey via `worstCaseBarContrast()`
(`glass-recipe.test.ts`).

**Secondary change, same commit:** the media header's subtitle used a
one-off literal (`rgba(240,238,233,0.40)`, task 1343) instead of the
material's own `labelMuted` token — deliberately faint, matching the design
mock. Against the OLD 0.46-alpha fill this was already borderline; against
the new material's near-opaque near-black fill, 0.40 alpha is comfortably
readable, but the point of a "safe" material is not to reintroduce a
borderline value at a different fill — switched to `PREVIEW_CHROME_MATERIAL.labelMuted`
(0.82 alpha), which `glass-recipe.test.ts` also asserts clears AA.

## Task 1563 round 4 (mobile) — media (video/image) ⋯ and close controls are invisible to Maestro/XCUITest (found, not fixed)

Not a deviation from the design — a testability gap found while verifying
this round's fix, recorded because it blocks a future Maestro pass the same
way the round-3 dev-client FAB did.

`maestro hierarchy` over an open video or image preview shows NO element for
"Close preview" or "Open file options" at all — only the bottom bar's
Share/Save/Versions/Info survive. The SAME two controls, using the SAME
`GlassCircle`+`TouchableOpacity`+`accessibilityLabel` pattern, ARE present
and tappable for every doc-branch type (PDF, markdown, code, docx, xlsx,
pptx, svg) in the identical layout position. The hierarchy dump's own
top-level accessibility text for the video case reads "Video, Liftable
subject available" — consistent with iOS's Visual Look Up / Live Text
subject-lifting analysis attaching to the native `VideoView`/`Image`
surface and shadowing sibling accessibility elements at the SAME screen
region, though this was not instrumented further to confirm the exact
mechanism. Pre-existing: `mediaHeader`'s `position:'absolute'`/`zIndex:20`
layout is untouched by this round (only its MATERIAL changed), so this is
not a round-4 regression — visual verification (screenshots
`16-mp4.png`/`19-heic.png`) confirms the controls render correctly and are
presumably reachable by a real tap/VoiceOver on-device; only the
Maestro/XCUITest accessibility-tree path is affected. Worked around this
round via `xcrun simctl terminate`+`launch` instead of driving the close
button. Not investigated further — out of scope for a chrome-material task.

## Task 1563 round 5 (mobile) — PDF cannot show content UNDER the translucent bars while scrolling (found, not fixable within this library)

Round 4 made `previewArea` full-screen, which fixed the "dead band" bug but
removed all top/bottom content inset — a document's first line then sat
UNDER the floating header (PDF title colliding with the clock, a DOCX's
first two lines hidden behind the title pill). Round 5's fix: content
starts just below the floating bar at rest, and moves UNDER the translucent
bar when scrolled (Photos/Files/Notion behaviour), implemented via
`contentContainerStyle`/CSS-body padding on each renderer's own scroll
surface (`src/lib/preview-content-inset.ts` computes the shared inset).

For every RN-native scroll surface (CodeRenderer, MarkdownRenderer, Xlsx's
FlatList, Pptx's FlatList) and the DOCX WebView (CSS `body` padding), this
works exactly as intended: the scroll VIEWPORT stays full-bleed (edge to
edge, unclipped), only the CONTENT gets extra padding, so scrolled content
naturally passes back under the translucent header/bottom bar — confirmed
on-device with the `1563-big-file.txt` fixture (`evidence-1563-redesign-r5/
screenshots/bigtxt_02_scrolled.png`): scrolled lines are visibly ghosted
behind the header pill and the read-only banner, both still legible on top.

**PDF is the one exception, and it is a real library limitation, not an
oversight:** `react-native-pdf` 7.0.4's `PdfProps` (checked against its own
`index.d.ts`) exposes no `contentInset`/content-padding equivalent — the
library owns both the scroll viewport AND the scrollable content as one
native view, with no way to inset content without also shrinking the
viewport. `PdfRenderer`'s new `topInset`/`bottomInset` props are therefore
applied as CONTAINER padding, which correctly satisfies "first line clears
the bar at rest" (confirmed: `evidence-1563-redesign-r5/screenshots/
pdf_01_rest.png`) but the padding bands show the page-gutter colour
(`pdfBleedBg`, `#2A2A28`) at ALL scroll positions, never actual page
content — confirmed by scrolling to page 3 and finding the gutter-coloured
band unchanged (`pdf_03_scrolled_retap.png`). Not investigated further
(would need forking or replacing `react-native-pdf`) — out of scope for
this task.

**Testing note, same round:** driving a scroll gesture on the PDF branch
(and, with only one slide, the PPTX branch) via Maestro's `scroll`/`swipe`
commands toggles `barsVisible` off — the same `Pressable onPress=
{handleContentTap}` wrapping every doc-branch renderer, whose tap-to-hide
gesture pre-dates this round and is unrelated to the inset fix. Plain RN
`ScrollView`/`FlatList` surfaces (CodeRenderer, MarkdownRenderer, Xlsx,
DOCX's WebView) correctly claim the pan as a scroll and never trigger the
tap; `react-native-pdf`'s own native scroll view apparently does not
signal "gesture claimed" back to the wrapping RN responder the same way,
so a scroll's touch-up still fires `onPress`. Worked around for evidence
capture with an extra tap after scrolling (which only toggles the bars back
on, not the scroll position) — not fixed, since it is pre-existing and out
of scope for a content-inset task.

## Task 1568 (mobile) — audio player has no design mock; look derived by analogy

**Design:** `design/preview-redesign-ios.html` has no audio mock at all — the
same gap task 1565 (finding 2) and 1563's own notes already flagged for
video ("there is no separate video mock… DERIVED by analogy to the photo
one"). Confirmed again for this task: `grep -i audio design/
preview-redesign-ios.html` matches nothing.

**What shipped:** a centered card (icon, title, format+duration, play/pause,
scrub bar, elapsed/remaining in JetBrains Mono) sitting on the doc-branch's
themed root (`c.paper`), not the media branch's forced-dark full-bleed stage
— audio has no visual content of its own to bleed edge-to-edge, so it
belongs with PDF/DOCX/etc.'s doc header and background, not image/video's.
Amber is used ONLY on the play button while `status.playing` is true (brand
rule: amber reserved for encryption state + primary actions) — paused/
loading states stay on neutral `paper2`/`ink`/`ink3` tokens, no color
otherwise added to the design. See `AudioRenderer.tsx`'s own doc comment for
the full reasoning, including why the "playing" icon uses a fixed `#000000`
literal rather than the theme's `c.ink` token (amber's hex value is fixed
across light/dark, so the icon riding on it needs to be too).

**Also found while building this** (not a design deviation, a correctness
bug, fixed as part of this task): `extensionForMime()` collapsed EVERY audio
mime/extension to a hardcoded `'.mp3'` before this task, regardless of the
file's real container — a `.wav`/`.m4a`/`.aac` upload was being decrypted to
a temp file literally named `*.mp3`. Fixed via the new `extensionForAudio()`
(`lib/audio-format.ts`), mime-mapped first with a filename fallback. Proven
end-to-end on-device (not just by the unit tests): with the FLAC preview
open, `xcrun simctl get_app_container … data` + `ls Library/Caches/preview/`
showed the live temp file as `<uuid>.flac`, and after closing the preview
the file was gone from that same listing — see this task's Notes for the
exact commands/output.

**expo-audio config plugin, minimal permissions:** `expo-audio`'s config
plugin defaults to requesting `NSMicrophoneUsageDescription` (iOS) and
`RECORD_AUDIO` (Android) and enabling background-playback capability
(`UIBackgroundModes: ['audio']`, Android foreground-service permissions) —
none of which this app needs (playback-only, background audio explicitly
"not required" per the brief). `app.json`'s plugin entry sets
`microphonePermission: false`, `recordAudioAndroid: false`,
`enableBackgroundPlayback: false` so none of those permissions/capabilities
are added — consistent with the product's privacy stance of never asking
for a permission the app doesn't use.

## Task 1569 (mobile) — RAW camera preview

**No design mock exists** (`grep -i raw design/preview-redesign-ios.html`
matches nothing) — derived by analogy to the existing photo branch, since an
earlier comment in `PreviewScreen.tsx` ("images/RAW on black") already
anticipated RAW joining the same full-bleed black media stage as photos/
video, not the doc branch's themed card. `RawRenderer` reuses that exact
visual frame (media header, `imageBleedBg` black background, bottom bar).

**Route considered and set aside: `exifr` (both for the thumbnail AND the
EXIF half).** See `src/lib/raw-preview.ts`'s own top doc comment for the
full account — short version: `exifr.thumbnail()` only produced a usable
image for 2 of this task's 6 real fixtures, and even after switching to a
hand-rolled "largest embedded JPEG" byte scanner for the image (which DOES
work for all 6), `exifr`'s EXIF parsing broke the Release build outright —
its only RN-resolvable build contains an internal dynamic `import()` that
Hermes cannot compile ("Invalid expression encountered"), reproduced and
confirmed on this exact build before being replaced with a ~150-line
hand-rolled TIFF/EXIF reader (`parseTiffExifTags`/`findJpegExifTiffOffset`,
unit-tested, zero third-party bundle risk). `exifr` was removed from
`package.json` entirely.

**Investigated on-device (bb-ios27, Release) — a claim below turned out
WRONG, corrected here rather than rewritten (workspace CLAUDE.md's own
"leave the wrong claim visible" rule):** early in this task the screen
rendered its header/bottom bar chrome correctly but a fully BLANK BLACK
content area — no spinner, no image, no error text, no crash. At the time
`RawRenderer`'s root `View` used `flex: 1`, and `PreviewScreen.tsx`'s
`mediaStage` (this component's direct parent) sets `alignItems:'center'/
justifyContent:'center'` — the same shape as the WebView-under-a-centered-
parent trap this repo's `CLAUDE.md` already documents — so switching `fill`/
`center` to percentage `width:'100%'/height:'100%'` (matching `mediaImage`'s
own style) looked like the fix and was documented as one, including a
broadened `CLAUDE.md` note generalizing the WebView trap to "any `flex:1`
child."

**That diagnosis was wrong.** The blank area persisted identically AFTER the
percentage-sizing change (still fully black, still no error). Root-caused
properly a few iterations later, with an on-screen debug harness (console
output is not observable in this Release/simulator setup — no capture method
tried surfaced JS `console.*` at all): the REAL bug was `findLargestJpegSpan`
picking a structurally-valid-looking but WRONG span (see that function's own
doc comment and the "Real bug" note below) — the `<Image>` was being handed
a genuinely corrupt/wrong JPEG, which iOS's image view renders as nothing,
not an error. A hardcoded `flex:1` colored box placed in the exact same JSX
slot DID fill the screen correctly, proving the centering-parent theory was
never the cause here. **The percentage-sizing change and the broadened
CLAUDE.md note are left in place** (harmless, and consistent with the
sibling `isImage` branch's own established pattern) **but did not fix
anything** — flagging this so a future reader doesn't cite this task as a
second confirmed case of the WebView-class bug affecting plain Views; it
isn't one.

**Real bug found and fixed (the actual one): `findLargestJpegSpan` picked
the wrong span for `sample.cr2`.** RAW sensor data following the real
embedded preview can, by byte-pattern coincidence, form a complete,
well-formed-looking JPEG (valid SOI/markers/EOI) that is LARGER than the
genuine preview but decodes (confirmed with both Pillow and ImageMagick) to
a flat, wrong, noise-banded image. "Largest span wins" alone picked this
false positive 92% of the time it mattered (1 of this task's 6 fixtures hit
it directly; the other 5 never had a competing false-positive span large
enough to matter). Fixed by rejecting candidate spans whose own declared
SOF dimensions are implausible for their byte size (over ~1.0 bytes/pixel —
every genuine preview across all 6 fixtures measured 0.05–0.83) before
falling through to the next-largest candidate. See `findLargestJpegSpan`'s
own doc comment in `raw-preview.ts` for the full account, byte offsets, and
measured ratios.

**Second real bug found and fixed, same investigation: `bytesToBase64` used
`String.fromCharCode(...chunk)` in 0x8000-byte chunks** — correct under
Bun/V8 (verified: byte-for-byte identical to Node's `Buffer` encoding, even
for the full 4.45MB real file), but produced a subtly corrupted encoding
under Hermes on-device that a header-only check (`sips`/`file`) does not
catch (dimensions still report correctly; only a real decode fails). Fixed
by switching to a plain one-character-at-a-time loop, matching this
codebase's OTHER base64 encoders (`transfer-api.ts`) exactly — none of them
chunk+spread either. Neither of these two bugs individually was sufficient
to explain the symptom alone; both were real, both are fixed, and the
`sample.cr2` preview was independently re-verified correct in the simulator
after each.

## Task 1583 (mobile) — Info sheet: rows, "Stored in", stacking vs `design/preview-redesign-ios.html` section 03

Guus's device screenshot (build 219) of the Info sheet: unreadable row labels, the
bottom bar floating over the sheet and its Versions list, and rows that were machine
detail or contradicted the card above them. Against the section 03 mock:

- **Rows.** The mock lists Modified / Uploaded from / Folder / Shared, then versions.
  The sheet keeps Modified / Folder / Shared and adds Format, Type (mono), Created and,
  for RAW, the camera rows (the mock's figcaption: "Info shows camera, lens and
  exposure"), then **Stored in** ("Falkenstein, Germany", from `GET /api/v1/region`,
  the server's documented source for "stored in {city}"; "Europe" when unknown, never
  the old "EU region" filler). Dropped: Chunks (machine detail), Encryption
  ("Decrypted on this device" read as contradicting "Encrypted on your device"; the
  card says it in words), Version (the Versions section lists every version).
  "Uploaded from" is still absent: the client `FileEntry` / `FileVersionEntry` types carry
  no device field (server not checked for one). Rule lives in
  `src/lib/preview-info.ts`.
- **Label colour.** The mock's `dt` colour (#8F8A80) is ~4.2:1 on the light paper, under
  AA for 13pt text. Labels use `ink2` (9.2:1 dark, 6.8:1 light), values `ink`.
- **Stacking.** The mock's sheet (z 16) covers the bottom bar (z 12) and does not reach
  the top bar. The sheet layer now sits at zIndex 18: above `bottomBarWrap` (15), below
  `chromeLayer` (20), so close and ⋯ stay live while it is open. The task file asked for
  the header "dimmed or hidden" while the sheet is open; the mock keeps it undimmed and
  Guus's report is that those buttons must work, so it stays. ⋯ with the sheet open now
  closes the sheet and opens the menu instead of stacking the two.
- **Versions, one home.** The mock keeps a Versions bar button AND a versions list in the
  sheet. Both stay; the button now opens the sheet scrolled to the Versions section
  (before, it opened the same sheet at the top as Info did).
- ~~**Still deviating (unchanged from 1563):** an opaque `c.paper` sheet, inset with four
  rounded corners, not the mock's edge-to-edge glass sheet.~~
  **Geometry fixed 2026-09-27** (Guus, device: "Why does it seem that the info sheet is not
  full width?"): the sheet is now full width (left/right 0), attached to the bottom edge
  (bottom 0, home-indicator inset as padding inside the sheet), top corners only at
  `GLASS_RADII.sheet` (38pt — the mock's 9cqw is ~38.8pt on a 402pt screen).
  **Still deviating:** the material — opaque `c.paper`, not the mock's
  `rgba(30,30,29,.92)` + 24px blur — and no 1px top hairline (the mock's
  `border-top: rgba(255,255,255,.08)`); the sheet height stays 72% (capped below the
  header) rather than the mock's 62%, so the Versions list has room. The ⋯ menu was
  checked against section 02: the mock draws it as a right-anchored popover
  (`.menu{right:3.5cqw;width:58cqw}`), not a sheet, and the code's
  `PreviewOptionsPopover` matches that — unchanged.

## Task 1586 (mobile) — every bottom sheet full width + draggable by the handle

Guus, build 221 (verbatim): "Only the share sheet is not full width, but make sure that every
sheet going from bottom to 70%-isch, is full width" and "Oh and sheets should be draggable by the
handle right. The top handle. So you can drop it more down/halfway etc".

All partial-height sheets (Info, Share, Encryption details) now render through ONE primitive,
`src/components/sheet/BottomSheet.tsx`: left/right/bottom 0, top corners `GLASS_RADII.sheet`,
home-indicator inset inside, grab handle (+ header) draggable between detents (half 50 % /
default 72 % / large 90 %, `src/lib/sheet-detents.ts`), fling or low release dismisses,
rubber-band above the top detent, content scrolls at every detent with hand-over at its top,
VoiceOver-adjustable handle. Deliberate exceptions:

- **The Share sheet** floated inset 10pt with four 38pt corners (1315, "the canvas floats the
  share sheet"). Guus's ruling above supersedes the canvas: it is full width now.
- **`BBActionSheet`** (file-row long-press menu) stays on its own implementation: it was already
  full width and bottom-attached, and a content-height action menu has no half/default/large to
  snap between — the whole sheet already drags down to dismiss (0777). Radius stays `radii.xl`.
- **Encryption details** (`TrustDetailsSheet`) gets half + default only; its content is shorter
  than a 90 % sheet.
- **Info sheet large detent** stops below the preview's top chrome (close / title / ⋯ stay above
  the sheet and usable, 1583) — ~84 % on an iPhone 17 Pro instead of 90 %.
- **Share sheet + keyboard:** while the software keyboard is up the sheet sits on it and grows to
  its tallest detent (not verified on the simulator — it runs with the hardware keyboard).
- **`GlassSheet` / the glass gallery's sheet specimens** keep their floating geometry: they are
  material swatches on a __DEV__ page, not presented sheets.

## Task 1587 (mobile) — "+" → New file (D3 "icon wells" picker + name step)

**Design:** `design/ios-new-file-d-variants.html` V3 "D3" (Guus's pick, 2026-09-27) for the
picker; `design/ios-new-file.html` step 3 for the name step. The brief says a new file is
created **empty**.

**What shipped instead, and why (none of these was ruled on by Guus; recorded so they are
reviewed, not discovered):**

- **The new file is not empty.** A Markdown note starts as `# <name>\n\n` (a level-1 heading
  from the name, then a blank line); a Text file (any extension) starts as a single `\n`.
  Reason: the preview decrypt path (native `downloadAndDecryptFileNative` and the JS fallback)
  refuses a 0-byte plaintext ("Invalid download size metadata"), so an empty file could be
  created but never opened — found on bb-qa-2 while verifying. The 0-byte decrypt gap itself
  (which also bites when a user clears a note and saves) is follow-up item 9 in workspace task
  1585, not fixed here. `lib/new-document.ts` `initialDocumentContent`.
- **Label sizes:** the tile name under the well is 12pt and "SOON" 9.5pt; the mock is about 9pt
  and 7pt at phone scale, chosen by the implementing lane for legibility on a phone.
- **The outline document icon is drawn with Views** (seven hairline Views + a Text), not the
  mock's SVG path: there is no SVG library in the tree and no new native deps were allowed.
  The extension inside it is smaller than the mock's (4.3/5.4/7.2 units for 4/3/2 letters, no
  tracking for 4) with 1.5 units of clear space to each stroke, because the first build's
  "DOCX" ran edge to edge (Guus's screenshot) — `docIconLabelMetrics`, unit-tested.
- **No "Stored in" row on the name step.** The mock shows where the file is stored; before the
  upload there is no storage pool to name, and naming a city we have not yet chosen would be a
  claim we cannot check. The step shows "Saves to <folder>" only.
- **Android "+" menu is flat** (Upload photo, Upload file, Scan, New file, New folder) instead of
  iOS's inline "create" section: `@react-native-menu/menu`'s Android side has no
  `displayInline`, so the section would render as a blank row opening a submenu.

## Task 1591 — store-blocking UI fixes (App Store capture pass, 2026-09-27)

- **Recovery phrase header / buttons (no artboard).** No canvas artboard exists for the
  onboarding screens (see the 1445 line above). Changed to the brand rule, not to a design:
  the mark (36 pt) and wordmark (20 pt) sit in one row with a 10 pt gap (the 48 pt mark used
  to overhang a 44 pt box into the wordmark), and "Copy all words" became the secondary
  (outlined) button so "I've saved my recovery phrase" is the screen's ONE amber primary.
- **Preview status bar follows the surface, not only the theme.** Photo/video/RAW stage and
  the code/editor surfaces (`#282c34`) are dark in both themes, so the status bar is
  light-content there and the doc header's top scrim uses its dark stops over them.
  `lib/status-bar-style.ts`.
- **Encryption details copy.** "Key source" now states core's derivation (HKDF-SHA256 from
  your master key, per file; sealed request key for file-request uploads) and "Encrypted by
  <this device's name>" became "Encrypted on — Your device, before upload": the server keeps
  no record of which client encrypted a file, so naming this device was false for any file
  another client uploaded. `lib/trust-details.ts`.
- **Prove it** shows the decrypted first 512 bytes on the left (it showed the ciphertext on
  both sides) and no longer prints the API download URL. `lib/encryption-proof.ts`.

## Task 1592 (mobile) — iOS polish for build 223 (from the build-222 regression)

No design mock covers these states; recorded so they are reviewed, not discovered (none was
ruled on by Guus):

- **Failed preview load → "Try again".** Every renderer's "Couldn't load …" state now carries
  an outline "Try again" button (secondary action, so not amber — brand rule). A file whose
  row is still marked as uploading reads "Still uploading" / "This file is still uploading.
  Try again in a moment." instead of the raw native exception. `lib/preview-load-error.ts`.
- **A name that cannot be decrypted** reads "Folder — name unavailable" / "File — name
  unavailable" in ink3 italic instead of the grey placeholder bar forever. `lib/row-name.ts`.
- **Info sheet "Shared" row:** "…" while loading; hidden (not "Not shared") when the share
  state cannot be read (e.g. a share recipient). `lib/preview-info.ts` `resolveInfoShareCount`.
- **Dates** in the share-link expiry, file-request expiry, last-backup date and ZIP/archive
  entries use the device locale with a spelled month ("4 Oct 2026 at 23:28" on en-GB,
  "Oct 4, 2026, 11:28 PM" on en-US) instead of all-numeric or hard-coded English.
  `lib/date-format.ts`. Other dates in the app keep their existing (English month) format.

## Task 1037 (mobile) — no in-app signup; needs_plan screen and lapsed banner

No design mock covers these states. They are recorded here so they get reviewed rather than discovered:

- **In-app sign-up removed.** `SignupScreen`, `SignupEmailCodeStep` and the post-signup recovery-phrase onboarding (`OnboardingScreen`, route `RecoveryPhrase`) are gone. The Login footer is one line of plain text: "Create your account on the web at beebeeb.io, then sign in here." It has no link, because the web sign-up shows trial prices (task 1400, App Review 3.1.1(a)). `WEB_ACCOUNT_LINKS_ENABLED` in `lib/web-links.ts` turns it into a link to `{web app}/signup` once a link-out is allowed.
- **needs_plan** (`screens/NeedsPlanScreen.tsx`): a full-screen overlay above the navigator, styled like `PhraseNotConfirmedScreen` (plain surface, brand mark, one amber primary). The primary is `Refresh`, the secondary is `Sign out`, and the copy is plain text pointing to beebeeb.io. The same switch adds an `Open beebeeb.io` link to `/choose-plan`.
- **lapsed**: a persistent, non-dismissable amber banner at the top of Files (the storage-banner shape, with wrapping text so the deletion date is never cut off). Settings and Storage & Plan show a `READ-ONLY` badge and "Read-only · deleted on {date}". Neither has a purchase or manage link, because the app has no billing link-out anywhere.
- **Trial with a payment mandate** (`trial_auto_converts`): "Trial ends {date} · continues automatically" under the existing `TRIAL` badge. A legacy no-card trial keeps "Trial ends {date}".

## Task 1605 (mobile) — no "pay now" button; informational cap/cancel copy only

The brief (`.claude/tasks/in-development/1605-trial-abuse-limits-cancel-readonly-retention-cap.md`,
mirroring the web half) asks for a **"Pay now to unlock \<plan\> storage" button** on the trial
card, calling `POST /billing/trial/pay-now` to charge the first period immediately. **Not shipped
on mobile — no purchase/pay-now action exists in this app, on this screen or anywhere else.**

**Why:** task 1400 (App Review 3.1.1(a), same rule `account-state.ts` and `StorageScreen.tsx`'s
file headers already state) — this app has no In-App Purchase product configured, and neither a
button nor a link to an external purchasing mechanism is allowed on this storefront.
`POST /billing/trial/pay-now` charges real money; a tappable button that calls it is exactly the
purchase call-to-action task 1400 removed everywhere else (`SHOW_PLAN_CATALOG = false`, no
"Manage subscription" CTA, no signup screen, no lapsed-banner purchase link).

**What shipped instead:** the same informational-only pattern as every other billing fact on this
screen (`PLAN_MANAGEMENT_NOTE`):
- Storage & Plan's status line reads "Uploads stopped · Access until \<date\> · Files deleted on
  \<date\>" for a never-paid trial cancelled before its first charge (never "Access until" alone,
  never "Renews") — `billing-status.ts`'s `billingStatusView`, task 1605 branch.
- An active mandated trial under the 25 GB cap shows one line: "This account is on the 25 GB
  trial storage cap until your first payment clears. Manage your plan from your account on the
  web." — `billing-status.ts`'s `trialCapNote`. No button, no price emphasis beyond the cap size
  itself, no "pay now" / "upgrade" wording (see the module's own test asserting this).
- A 409 `trial_cancelled_read_only` upload/backup/share refusal and a 413 `quota_exceeded` with
  `is_trial_cap: true` both get their own honest message via `account-state.ts`/`friendlyError()`
  — "Resume your trial on the web" / "Manage your plan from your account on the web", never a
  local purchase action.

This is a deviation from the BRIEF, not from a design mock or a Guus ruling — recorded here per
the same "flagged, never shipped silently" convention rather than silently dropping the button or
silently adding one that would risk App Review rejection.

## Task 1689 — PhotosScreen's 1322 "blur ALWAYS on" decision is amended (2026-10-02, bug-rel lane)

Task 1322 deliberately mounted `ScrollEdgeBlur` UNCONDITIONALLY on PhotosScreen — the only such
mount in the app — with two recorded reasons: Photos is permanently full-bleed, and `isScrolled`
was permanently false on the shipping platform because the native grid never reported scroll.
Task 1689 (light-mode "rare fade" at rest) changes this, and the change is a deviation from that
recorded decision, recorded here per the same convention:

- **What changed:** the mount is now gated `{isScrolled ? <ScrollEdgeBlur …/> : null}`, matching
  every sibling screen (Files 4545, Settings 1826, Trash 386, Shared 737, Storage 403,
  BackupInsights 629). The trigger was Guus's 2026-10-02 report: in light mode the 0.30-alpha
  light tint (`glass-recipe.ts`'s derived `SCROLL_EDGE.lightTint`) renders as a visible
  "plain-band fade" over the grid's paper background at rest — with `contentInsetTop` the first
  row starts BELOW the header at rest, so the strip has nothing to make legible then.
- **What did NOT change:** 1322's second reason (no scroll signal on iOS) still holds — the
  native grid deliberately defers every bridge dispatch to rest positions. So `isScrolled` is
  derived from the grid's own `onVisiblePhotoIdsChange` via a top-photo-visible heuristic rather
  than a native scroll event; the FlatList fallback keeps its real `onScroll` derivation.
- **Recorded trade-off:** during the drag itself (before the grid settles) the header rides over
  unblurred content for the duration of the gesture — the same deferred-side-effect trade the
  native grid already makes for thumbnail prefetch. At rest (the bug state) the fade is gone in
  both schemes; while scrolled, the blur does exactly what 1322 wanted.

## Task 1690 — share sheet: always ONE full link (split presentation removed)

**Design:** the share-flow artefacts show the share result as two separate
items — `design/hifi/flows-upload-share.jsx` ("Share B — Decryption key
separate from URL", a bare URL plus a "Decryption key · send through a
different channel" box) and web's `hifi-upload-share.jsx`. The shipped share
sheet additionally badged the key box "SEND SEPARATELY" and copied the URL
and the key as two separate clipboard items.

**Ruling (Guus, verbatim, 2026-10-02):**
> "Met delen voortaan altijd full link, er staat nu dat het los is maar is
> eigenlijk alsnog 1 geheel. Maak er gewoon 1 geheel van."

**What shipped instead (2026-10-02):** the share sheet always presents and
copies ONE complete link — `/s/<token>#key=<K_c>` built by the new
`src/lib/share-full-link.ts` `buildFullShareLink()`. The bare-URL + raw-key
state pair, the "SEND SEPARATELY" badge, the 'link'/'key' copy targets and
the "separate channels" copy are removed. The key still travels only in the
URL fragment (1531 semantics untouched). The share link base now comes from
`getWebAppUrl()` (EXPO_PUBLIC_APP_URL / extra.appUrl, derived from the API
URL otherwise) — the same source LoginScreen/NeedsPlanScreen use — instead of
a hardcoded production origin, so local QA builds produce localhost:5173
links; production output is unchanged.

**Why:** the ruling is dated after the artefact and explicitly supersedes it
(precedent: task 1357, "a verbal ruling from Guus supersedes the artefact").

## Task 1704 slice 3 (mobile) — RecoveryUnlockScreen heading: canonical "Vault locked"

**Design:** no design artefact pins this screen's copy — `design/hifi/*.jsx`
and `design/ios26-canvas/` contain no RecoveryUnlock heading/subheading entry.

**Ruling (1684/1693, decision D-2026-10-02 option A — "net zoals in iOS"):
** the locked vault state carries the canonical title `Vault locked` with a
brief honest explanation and NO password form (1693 shipped exactly that on
web: "canonical title `Vault locked` (iOS parity)"). Task 1704 slice 3's
brief requires the post-reset / keychain-empty landing to use that same
language and offer the 12-word phrase unlock.

**What shipped (2026-10-02):** `RecoveryUnlockScreen`'s heading changed from
"Unlock your vault" to the canonical `Vault locked`, and its subheading now
states the two-tier story honestly (password unlocks the account; the
12-word recovery phrase unlocks the vault). Copy lives in
`src/lib/vault-locked-copy.ts`, pinned by `src/lib/vault-locked-copy.test.ts`
(source-scan precedent: `sheet-sweep.test.ts`). Layout and styles unchanged;
the screen's phrase input, retryable error banner and "Use another account"
escape are untouched.

**Why:** a Guus ruling supersedes the (absent) artefact (precedent: task
1357); recorded here because the shipped language intentionally diverges
from the screen's previous heading.

## 1721 — upload preparation wording (2026-10-03)
Guus reports RAW uploads lingering before transfer. Stage 1 includes local copying,
metadata encryption and session initialization; its label is now "Preparing on
your device…". Live encryption throughput remains in stage 2. No design geometry changed.

## 1723 — release preview regression repair (2026-10-03)

The Android streaming merge regressed iOS preview behaviors already covered in
the pre-PR `6ec146c` source: content-area swipe-to-close, locked-pager tap
affordances, the partial-file error card, PhotoPage export/resource bounds and
RAW EXIF keyed by file id. This repair restores those local PreviewScreen
behaviors while preserving the merged streaming UI's buffered-video badge and
single-file video streaming path. No design geometry changes.

## Task 1724 — cold folder latency (2026-10-04, Guus ruling)

Guus reports initial Files and every subfolder block for too long and asks for the delay to be fixed. Folder-specific paginated requests must start immediately and must not wait for the full vault index to hydrate, fetch, or persist. Persisted index rows are an optional temporary display; a late cache result cannot overwrite settled folder rows. Background search reconciliation uses bounded native batch decrypts and yields to visible browsing; no encryption or sync cursor checks are removed.

File Provider registration/mount prewarms root only; opened subfolders refresh on demand using the existing extension Secure Enclave path. Remove the duplicate full-vault walk at biometric unlock to avoid competing with browsing. Purge leases/epoch checks remain in force.
## 1724 — native iOS preview decrypt pipeline (2026-10-04)

Guus reported that iOS previews waited for the whole encrypted download before
decrypting, which made photos and videos feel slow. The previous native bridge
used `URLSessionDownloadTask`, wrote the full encrypted response, split it into
chunk files, then handed the complete set to Rust. This task intentionally
deviates from that whole-file staging model: `downloadAndDecryptFileNative`
now parses the existing chunk metadata, decrypts each complete authenticated
`nonce || ciphertext || tag` frame as it arrives, and promotes the preview
plaintext only after every frame, byte count and final size has verified.

Security constraints recorded with the change: partial plaintext lives under
the already-registered `Library/Caches/preview/` plaintext cache, native also
marks the directory/temp/final paths excluded from backup with
`completeUntilFirstUserAuthentication`, failed/cancelled writers remove only
their own UUID temp, and metadata is bounded with checked arithmetic. This
slice improves whole-file preview latency; AVPlayer loopback progressive
playback remains a separate 1724 slice. Evidence logs:
`/tmp/bb-1724-pipeline/red-preview-chunk-pipeline.mutation.log`,
`/tmp/bb-1724-pipeline/green-preview-chunk-pipeline.run.log`,
`/tmp/bb-1724-pipeline/ios-build-gate-final-wrapper.log`.

## Task 1724 — video stream lifetime (2026-10-04, JS slice)

Guus reports video playback still behaving like a whole-file download before useful playback. The streaming URI becoming playable is not a completed plaintext cache copy: JS now keeps a cache-path stream registry, joins duplicate opens to the same active partial stream, holds the plaintext gate lease until native terminal/cancel, and cancels the native stream on purge or last preview release. Runtime traces omit loopback capability URLs. This is a lifetime/security repair for the progressive stream path; native chunk scheduling and range-server behavior are owned by the native bridge slice.

## Task1724 — iOS progressive playback bridge

The bridge resolves a standard loopback byte-range source before the full video finishes buffering, preserving native opaque handles and authenticated chunk decryption. Native purge marks its pending gate first and cancels all streams before sweeping plaintext; handle/key release also closes capabilities. Terminal progress survives until polling reads it once. Streaming startup runs away from the UI executor. No keys, bearer tokens or capability URLs are exported to runtime logs.

## Task1724 — preview pruning excludes native working files

Native pipelines own UUID hidden temporary files/directories beneath the registered preview cache. JS cache eviction handles finished public cache entries only: it must not unlink a live native writer's temporary resource. Native cancel/error owns temporary cleanup, while the existing account plaintext purge sweeps the entire cache.

Cancellation ordering: JS stops progress polling immediately on explicit cancel or abort so the UI settles, but the `terminal` promise stays pending until native cancellation returns. `native-decrypt` releases the writer gate from `terminal`, so resolving it before native drain would allow purge or another writer while the native stream could still be touching plaintext.

Task1724 CI registration: register the new preview frame pipeline driver in the existing Swift test manifest and use its counted assertion format. Missing registration caused the CI gate to fail before publication could complete.

Task1724 native CI: keep compiler flags nonempty for every driver so the runner supports system Bash3.2 with nounset, as used by GitHub macOS. RED reproduced flags[@] unbound after the stream driver; verify all5drivers with /bin/bash.

Task1724 native working-storage cleanup: JS preview pruning intentionally skips native hidden working files to avoid unlinking live writers. Native now owns stale crash cleanup once per process per preview cache directory, before creating any new UUID temp file or stream directory. The cleanup only removes the two native-owned UUID patterns (`.<output>.<UUID>.tmp` and `.beebeeb-stream-<fileId>-<UUID>/`), preserves public cache entries and unrecognized dot files, and never repeats in the same process so a JS reload cannot delete files created by active native writers.
Evidence logs: `/tmp/bb-1724-pipeline-p2/native-preview-working-storage.mutation.log`, `/tmp/bb-1724-pipeline-p2/native-preview-working-storage.run.log`, `/tmp/bb-1724-pipeline-p2/preview-chunk-pipeline.run.log`, `/tmp/bb-1724-pipeline-p2/native-video-streamer-harness.run.log`.
Task1724 failed stream terminal/export helper: playable loopback success is now distinct from background terminal success. The JS wrapper exposes a non-rejecting `terminalStatus` union so the registry can evict a stream that later reports an authenticated chunk error instead of joining a dead capability URL. Failed entries release their writer lease, serialize their partial-output cleanup before retry, and preserve consumer lease accounting. `materializeVideoPreviewForExport(fileId, extension)` is the export/share bridge: it acquires an independent preview lease, waits for active stream terminal success, verifies the promoted local file exists, and returns only that file URI. Export/share callers must release the helper lease with `releasePreviewCopy(fileId, extension)` in their finally block.
Race follow-up: the process-once prepared marker is written only after the first sweep completes while holding the helper lock. A DEBUG barrier test proves a second prepare cannot return and create a live UUID temp until the initial sweep has finished, so the first sweep cannot delete that live writer.
The prepared key resolves symlinks as well as standardizing the URL, so an alias path to the same cache cannot trigger a second first-sweep in the same process. Evidence logs: `/tmp/bb-1724-pipeline-p2-race/native-preview-working-storage.race-mutation.log`, `/tmp/bb-1724-pipeline-p2-race/native-preview-working-storage.run.log`, `/tmp/bb-1724-pipeline-p2-race/preview-chunk-pipeline.run.log`, `/tmp/bb-1724-pipeline-p2-race/native-video-streamer-harness.run.log`.

Task1724 video export: use materializeVideoPreviewForExport terminal-success contract for loopback previews, hold an independent exporter lease until Sharing.shareAsync finishes, and release on error/abort. Never pass a localhost capability to sharing. Export slice source88a2bc5 supersedes intermediate polling drafte233140.
