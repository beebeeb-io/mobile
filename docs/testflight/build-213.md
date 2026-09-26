# TestFlight build 213 — export-compliance unblock + Files/Photos/2FA fixes

**App version:** 1.0.0 • **Build:** 213 • **Branch:** `release/213` off `main` `f81b3a4`

**Status as of 2026-09-26: build in progress, not yet on TestFlight.** Builds 210–212 were all
rejected by `eas submit` with a 409 ("Invalid Export Compliance Code") because
`ITSAppUsesNonExemptEncryption = true` requires a matching code, and the app's only encryption
declaration (`35c912e6`) has sat `IN_REVIEW` since 2026-09-15 with no code issued. Build 213
drops the `ITSAppUsesNonExemptEncryption` key entirely instead — see
`docs/export-compliance.md` §7 for the full reasoning. France was removed from the app's
storefronts as part of the same change (Guus, 2026-09-26).

Six PRs since the `build-212-p0-release.md` checklist (which itself listed #107–#110 relative
to the prior release), in merge order:

- **#114 — fix(share-view): show the decrypted filename; save as `name.ext`** (`fix/flow-ios-core-1`)
- **#115 — fix(startup): keychain read failure is not a network outage; DNS check names the configured host** (`fix/flow-ios-core-4`)
- **#118 — 1557: pin OPAQUE `ksf_version` threading; document the build-141 App Review login rejection** (`fix/1557-app-review-login-build`)
- **#117 — fix(2fa): verify step no longer traps the user (Back returns to the secret)** (`fix/flow-ios-core-0`)
- **#113 — Files tab: one Face ID prompt when opening a locked file** (`fix/flow-ios-core-2`)
- **#116 — fix(locks): hide locked files' thumbnails in Photos, Files and Recent** (`fix/flow-ios-core-3`)

Plus the export-compliance change (no functional code, config + docs only):

- **`ITSAppUsesNonExemptEncryption` removed** from `app.json` and `ios/Beebeeb/Info.plist`;
  France removed from sale via the App Store Connect API; per-build export questions will be
  answered truthfully in App Store Connect (encryption yes, standard algorithms, not in France).

Walk this on a real iPhone once the build appears in TestFlight. Capture screenshots where noted.

---

## 1. Double Face ID prompt fix (#113)

The bug: opening a locked file from the Files tab could trigger Face ID/Touch ID **twice** in a
row for a single open action.

- [ ] **1.1** Lock a file. From the Files tab, tap it to open.
- [ ] **1.2** Confirm exactly **one** biometric prompt appears before the file opens.
- [ ] **1.3** Repeat from a folder nested two levels deep, and from search results — same result,
  one prompt.

**Capture for verified/:** screen recording showing a single Face ID prompt end to end.

## 2. Locked thumbnails hidden everywhere (#116)

The bug: a locked file/photo's thumbnail could still render (unblurred, recognizable) in the
Photos grid, the Files list, and the Recent tab, even though opening it required unlock.

- [ ] **2.1** Lock a photo that has a distinctive thumbnail. In the Photos tab grid, confirm the
  tile shows a lock glyph / obscured placeholder, not the actual image.
- [ ] **2.2** Same file in the Files tab list view — icon/thumbnail should be obscured, not the
  real content.
- [ ] **2.3** Same file surfaced in "Recent" — same obscured treatment.
- [ ] **2.4** Unlock the file (biometric/passcode) and confirm the real thumbnail now renders in
  all three places.

**Capture for verified/:** screenshot of the Photos grid with a locked (obscured) tile next to
unlocked tiles.

## 3. 2FA setup no longer traps the user (#117)

The bug: partway through enabling 2FA (on the "verify code" step), tapping Back could leave the
user stuck instead of returning to the QR/secret step.

- [ ] **3.1** Settings → Security → "Set up two-factor authentication". Proceed to the code-verify
  step without entering a code.
- [ ] **3.2** Tap **Back**. Confirm you land back on the QR/secret screen with the **same secret**
  shown (not a freshly regenerated one, not a dead end).
- [ ] **3.3** From there, cancel out of setup entirely — confirm you return to Settings with 2FA
  still OFF (no half-enabled state).
- [ ] **3.4** Repeat the full flow to completion (scan QR, enter code) — 2FA should enable
  normally.

**Capture for verified/:** screenshot of the QR/secret screen reached via Back, showing the same
secret as before.

## 4. Shared file download shows the real filename (#114)

- [ ] **4.1** Create a share link for a file with a distinctive name and extension (e.g.
  `vacation-photo.jpg`).
- [ ] **4.2** Open the share link as a recipient (web or the shared-view screen). Confirm the
  displayed filename matches the original — not a generic "shared-file" or a truncated/garbled
  name.
- [ ] **4.3** Download/save the shared file. Confirm the saved file's name and extension match
  the original (`name.ext`), not a temp/blob name.

**Capture for verified/:** screenshot of the shared-view screen showing the correct filename.

## 5. Startup: keychain failure isn't reported as "no internet" (#115)

- [ ] **5.1** With Beebeeb signed in, force a state where the local secure-storage read fails if
  you can reproduce it (e.g. a corrupted keychain state from prior testing) — otherwise, at
  minimum confirm normal cold launch is unaffected by this change.
- [ ] **5.2** If a startup failure occurs, the error shown should be specific to the actual
  problem (keychain/secure-storage), not a generic "Check your internet connection" message.
- [ ] **5.3** Any diagnostics/DNS-check surface (Settings → Advanced → Diagnostics, if present)
  should name the actual configured API host (`api.beebeeb.io` in production) rather than a
  hardcoded placeholder.

**Capture for verified/:** screenshot of the diagnostics panel naming the correct host, if
reachable; otherwise note "cold launch normal, failure path not reproduced."

## 6. OPAQUE KSF threading regression guard (#118, informational)

This PR adds a regression test (`api.opaque-ksf-threading.test.ts`) pinning the OPAQUE
`ksf_version` threading that build 141's App Review login rejection traced back to (mismatched
KSF between the client and the demo/reviewer account). There is no new user-facing behavior to
manually test here — the check is that **sign-in for the App Review demo account still works**,
which is covered by the App Review smoke in `docs/app-store/review-notes.md`.

- [ ] **6.1** Sign in with the App Review demo account (credentials in the gitignored section of
  `docs/app-store/review-notes.md`). Confirm login succeeds without an OPAQUE/KSF error.

## 7. Export compliance change — nothing to test in-app

This is a config + App Store Connect metadata change, not app behavior. There is no in-app check
for testers. What to confirm on the App Store Connect side (lead/Guus, not a device tester):

- [ ] **7.1** The build's Info.plist has no `ITSAppUsesNonExemptEncryption` key (verified at
  build time — see the task report for `PlistBuddy` evidence).
- [ ] **7.2** App Store Connect's per-build export-compliance prompt is answered: encryption yes,
  standard algorithms only, not exempt, not available in France.
- [ ] **7.3** The app's France storefront availability shows "Cannot be sold" / unavailable.

---

## How to flag a failure

If any check fails: capture a screenshot + step number and file it. §1–§4 each trace to a
specific merged PR (#113/#114/#116/#117) — a failure there is a regression against code already
on `main`. §5 (#115) and §6 (#118) are lower-risk/diagnostic-only changes.
