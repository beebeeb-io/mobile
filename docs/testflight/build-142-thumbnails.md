# TestFlight build 142 — thumbnail quality verification

**App version:** 1.0.0 • **Build:** 142 (or whichever build number Apple assigns) • **Includes:** brand mark (final), 2FA OPAQUE fix, **0552 + 0553 thumbnail work**

Walk this on your real iPhone after the build appears in TestFlight. Each check has a clear pass/fail signal. Capture screenshots where noted — those are what move the tasks from `in-review/` to `verified/`.

---

## 1. Brand mark sanity (build 141 already shipped this, just re-confirm)

- [ ] **1.1** Home-screen icon is the new path-based "b" — optically centered, no font-availability glitches at any size.
- [ ] **1.2** In-app logo (login/onboarding screens) renders the same b — pixel-identical to the home-screen icon.

## 2. Sign-in with 2FA (re-confirm the build-136 fix)

- [ ] **2.1** Cold launch from clean install → enter `guus@devidee.nl` + password → 2FA challenge screen appears, NO "Invalid value provided to SecureStore" error.
- [ ] **2.2** Enter your authenticator code → reaches Files tab.
- [ ] **2.3** Try a backup code (if you remember one) → also works.

## 3. 0552 — PhotoKit-first thumbnail rendering

The key question: when you scroll the Photos grid, are your *own backed-up photos* rendered from PhotoKit (free, retina-perfect) or from the encrypted blob (slow, lower quality)?

- [ ] **3.1** **PhotoKit path active.** Open the Photos tab. Scroll. Most photos should render *instantly and crisply*. Compare adjacent tiles to the same photos in iOS Photos.app at the same zoom — they should look indistinguishable.
- [ ] **3.2** **Blurhash placeholder.** Pull down to refresh, fast-scroll while the network is slow (toggle Airplane Mode on, scroll back to top, toggle off, scroll down). Tiles should briefly show a **blurry gradient placeholder** (the blurhash), then sharpen as the real pixels arrive. NO white/empty tiles.
- [ ] **3.3** **Variant cache fix.** Open a folder in Files tab (list view, small thumbnails). Then switch to Photos tab (grid, large thumbnails). The grid should not look pixelated/upscaled from a 384px cached version — it should be crisp at full grid-tile size.
- [ ] **3.4** **100 KB cap.** Open Settings → Advanced → Diagnostics (if there's a "show cache stats" button), or just look at disk usage trends. New uploads should produce thumbnails up to ~100 KB (was ~25-30 KB on degrade-ladder photos before).

**Capture for verified/:** screenshot of Photos grid + a comparison shot of the same photos in iOS Photos.app.

## 4. 0553 — Bulk backfill of degraded thumbnails

- [ ] **4.1** Settings → Advanced → **"Improve thumbnail quality"** card is visible alongside the existing repair tools.
- [ ] **4.2** It shows a count: "X of Y files have degraded thumbnails" or similar.
- [ ] **4.3** Tap **Start**. Progress UI shows "Processing N of M files" with MB downloaded counter.
- [ ] **4.4** **Pause/resume**: force-quit Beebeeb mid-job, relaunch → the worker resumes from where it left off (or shows "Paused — Resume" button that picks up the same file index).
- [ ] **4.5** **WiFi-only toggle**: enable, turn off WiFi (cellular only) → no traffic flows. Re-enable WiFi → resumes. (This one is the structurally-unverifiable-in-sim point we needed real device for.)
- [ ] **4.6** Let it run to completion (or to a meaningful sample — say 100 files). Check Settings → Storage or another visible metric to confirm thumbnail bytes per file are now larger.

**Capture for verified/:** screenshot before / during / after. Or the diagnostics panel showing "X thumbnails improved".

## 5. Settings: smoothness slider new semantics

- [ ] **5.1** Settings → Performance → slider has three positions: **Data saver / Balanced / Smooth**.
- [ ] **5.2** Copy explains what each does in terms of *download behavior*, not thumbnail size.
- [ ] **5.3** Estimated cache size shown is roughly `(non-PhotoKit thumbnail count) × 100 KB`.

## 6. Reality-check spot

You said the Photos grid looked blurry yesterday at 4525 of 9346 backed up. With this build installed, walk the same grid:

- [ ] **6.1** Subjectively: does it look noticeably better?
- [ ] **6.2** If a specific tile still looks blurry, long-press → "Inspect" / Details → is the thumbnail bytes value < 30 KB? If yes → that's a degraded thumbnail; the bulk backfill (§4) should fix it after a run.

---

## How to flag a failure

If any check fails: capture screenshot + console excerpt (Xcode Console.app filtered to "Beebeeb") + step number, and message me. I'll move the task back to `in-development/`.

If everything passes, message "0552 + 0553 verified, here's the screenshots" and I'll move both to `verified/` and close them out.
