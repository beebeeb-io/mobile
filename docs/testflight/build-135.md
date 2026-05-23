# TestFlight build 135 — what to test

**App version:** 1.0.0  •  **Build:** 135  •  **Submitted:** 2026-05-23

Build 135 is a security + performance + size cluster. 22 tasks land in this build (0426–0447). The two most important things to verify in the field are the **shared-Keychain migration round-trip** (P0 0447) and the **share extension end-to-end** (0428/0433/0444/0445), because they couldn't be exercised on the simulator with empty entitlements.

If a tester only has 10 minutes, run **Critical-path smoke (§1)** + **0447 device-backup round-trip (§4.1)**. The rest is welcome but optional.

---

## 1. Critical-path smoke (5 minutes — every tester)

Quick happy-path sweep — nothing under here is allowed to break. If any step fails, capture a screenshot + log path and report it.

| # | Step | Pass criterion |
|---|---|---|
| 1.1 | Cold launch the app from a clean install | Onboarding splash loads in < 2 s, no white screen |
| 1.2 | Sign up: tap "Create account", enter email + password, accept ToS | OPAQUE signup succeeds; 12-word recovery phrase appears |
| 1.3 | Verify 3 random words of the phrase as prompted | Verification accepts the correct words; tapping wrong words shows error |
| 1.4 | Complete onboarding → land on Files tab | Files tab renders with empty state |
| 1.5 | Tap "Add file or folder" → "Upload photo" → grant Photos access → pick any photo | Upload progresses; file appears with decrypted filename + thumbnail |
| 1.6 | Tap the uploaded photo | Preview renders the actual image, Details panel shows Size / Chunks / "Decrypted on this device" |
| 1.7 | Sign out via Settings → confirm | App returns to login screen |
| 1.8 | Sign back in with the same email + password | Files tab loads with the uploaded photo still present |
| 1.9 | Force-quit the app (swipe up) and relaunch | App auto-unlocks (Face ID/Touch ID prompt if enabled, or silent); no recovery phrase re-entry needed |

---

## 2. Cold launches and unlock fallbacks (P1 — 0448)

Vault unlock has multiple paths. Each must reach a usable Files tab without leaving the user stranded on a blank screen.

| # | Setup | Action | Pass criterion |
|---|---|---|---|
| 2.1 | Signed in, Face ID enabled | Cold launch | Single Face ID prompt → Files tab. Face ID does NOT fire on every tab switch (regression from earlier fix) |
| 2.2 | Signed in, biometrics OFF | Cold launch | Silent keychain auto-unlock → Files tab. No prompt. |
| 2.3 | Signed in, but device was wiped / fresh install of the IPA | Cold launch | App detects missing master key → automatically navigates to "Enter recovery phrase" screen (NOT a blank screen) |
| 2.4 | On the recovery phrase screen from 2.3 | Enter the 12 words | Vault unlocks, Files tab loads with all previously uploaded files |

> **Known limitation:** on first install when the Photos tab is opened before anything else, ensure no crash about "documentDirectory" (regression check for 0446).

---

## 3. Encrypted upload / download / preview (P1)

| # | Step | Pass criterion |
|---|---|---|
| 3.1 | Upload a small image (< 1 MB) | Progress bar smooth; thumbnail appears within a few seconds; full preview opens to the actual image |
| 3.2 | Upload a large image / video (50–200 MB) | Upload completes (no silent failure); preview opens; full file plays/renders. **This exercises 0427 (FileProvider OOM fix) when uploading via Files.app drag.** |
| 3.3 | Open a PDF, DOCX, XLSX preview | Preview renders content (libraries lazy-loaded on first use per 0432). First open may take a few hundred ms; subsequent opens fast. |
| 3.4 | Preview a 100 MB file | Decrypt completes; UI doesn't hang. **This exercises 0438 (contiguous-body decrypt fast-path).** |
| 3.5 | Preview → "Export via iOS" | iOS share sheet appears with the decrypted file ready to Save / Copy / Print |

---

## 4. Security verifications (P0 — must verify)

### 4.1 0447 sessionToken not in unencrypted backups (highest priority)

This is what build 135 most needs proving in the field. The simulator can't exercise the real backup path because the entitlements differ.

1. On an unlocked iPhone, **sign out** of Beebeeb, then **sign back in** with email + password. This is the path that writes the new keychain entry.
2. Connect the iPhone to a Mac via USB.
3. In Finder → device → tap the iPhone. Click "Back up all of the data on your iPhone to this Mac". **Do NOT tick "Encrypt local backup"** — we explicitly want the unencrypted form for this test.
4. Once the backup completes, locate it at `~/Library/Application Support/MobileSync/Backup/<device-id>/`.
5. Inside that folder, find the file whose hash maps to `group.io.beebeeb.shared.plist`. The fastest way: open Terminal, `cd` to the backup folder, run:
   ```
   find . -type f -exec sh -c 'plutil -p "$1" 2>/dev/null | grep -l beebeeb' _ {} \;
   ```
6. **Pass criterion:** the matching plist must NOT contain `io.beebeeb.sessionToken` or `io.beebeeb.apiBaseUrl`. If either key appears, that's a fail — capture the value and report.

If you don't have Mac access, the alternative is to enable iCloud Backup, wait for an iCloud backup to complete, then sign in to iCloud.com → Settings → restore the backup to a fresh device and check if Beebeeb auto-authenticates. If it does, the token leaked.

### 4.2 0428 / 0433 / 0444 / 0445 share extension end-to-end

These are the share-extension cluster — must work on a real device because the sim couldn't drive the iOS share sheet reliably.

1. Sign in to Beebeeb. Confirm Files tab loads.
2. Open **iOS Photos.app**. Tap any photo.
3. Tap the **Share button** (square with up-arrow).
4. Scroll the apps row. **Beebeeb** must appear in the share targets.
5. Tap Beebeeb. **Pass criterion #1:** the Beebeeb share sheet loads (folder picker, "Save" button). No spinner-of-death, no "vault locked" error. This proves the master key is reachable from the share extension via the shared keychain.
6. Pick a destination folder or accept the default. Tap Save.
7. Wait. **Pass criterion #2:** a success toast or check mark appears, the share sheet dismisses, and the file appears in Beebeeb's Files tab with the correct decrypted filename + a real thumbnail (not a generic icon).
8. **Pass criterion #3:** the photo is the SAME photo — open it in Beebeeb and visually compare to the original in Photos. They should match bit-for-bit (this confirms the share extension didn't corrupt the upload).

### 4.3 64a4416 clipboard auto-expiry for secrets

1. Settings → Account → "Show recovery phrase". Authenticate.
2. The phrase appears. Tap "Copy to clipboard".
3. Open **Notes.app**. Paste. The 12 words should appear. ✓
4. Wait **60 seconds** without interacting with Beebeeb (you can switch to another app, just don't tap inside Beebeeb).
5. After 60 s, switch back to Notes. Try to paste again. **Pass criterion:** the clipboard is empty (or contains the previous clipboard value), NOT the recovery phrase.
6. Repeat for: Settings → Security → "Set up two-factor auth" → during the QR step there's a "Copy secret" button. Same 60 s auto-expiry should apply.
7. Repeat for: 2FA backup codes screen → "Copy all codes". Same expiry.

### 4.4 64a4416 HTTPS deep link only

1. Open Safari. Try opening `http://beebeeb.io/recovery?token=foo` (note: HTTP, not HTTPS). **Pass criterion:** does NOT auto-open the Beebeeb app — should open Safari to the URL (which itself redirects to HTTPS).
2. Try `https://beebeeb.io/recovery?token=foo`. **Pass criterion:** opens the Beebeeb app or shows the deep-link prompt.
3. Try `beebeeb://upload`. **Pass criterion:** opens the app to upload screen.

### 4.5 0430 backup token not in App Group plist (regression)

Already verified static in earlier builds. On this build, confirm the photo backup still works (token reads from keychain):

1. Settings → Photo Backup → ON.
2. Pick a destination folder.
3. Wait. Photo backup should progress (status visible on the Photos tab or Settings).
4. Force-quit the app. Wait 10 minutes (background task). Reopen Beebeeb. **Pass criterion:** backup state is correctly preserved; no "auth required" error.

---

## 5. Backup engine (P1 — 0434 / 0435 / 0440 / 0443 / 0439 / 0441 / 0442)

| # | Step | Pass criterion |
|---|---|---|
| 5.1 | Settings → Photo Backup → turn ON | UI never freezes (0434 fixed a deadlock) |
| 5.2 | Start a backup of ≥ 100 photos. Force-quit the app mid-backup. | Backup resumes correctly on next launch; no duplicate uploads (0435) |
| 5.3 | While photo backup is running, scroll the Photos tab fast | UI stays smooth — no jank from PHKit callbacks (0440 / 0443) |
| 5.4 | Settings → Calendar Backup → turn ON | Calendars export to a .ics file in vault. Open the .ics in Calendar.app — events should match source exactly (0439 RFC 5545 compliance) |
| 5.5 | Settings → Contacts Backup → turn ON | Contacts export to a .vcf file in vault. Open .vcf in Contacts.app — contacts match (0441) |
| 5.6 | Disconnect from Wi-Fi briefly during a backup | Backup retries, never hits `localhost:3001` (regression for 0442 — should hit production API only) |

---

## 6. Files.app integration (P1 — 0427 + 0447 read path)

**Note:** the File Provider domain registration must be enabled in onboarding. If you declined it, re-enable via Settings → File Provider.

| # | Step | Pass criterion |
|---|---|---|
| 6.1 | iOS Files.app → "Browse" → "Locations" — "Beebeeb" appears as a location | If not visible, tap "Edit" and enable Beebeeb |
| 6.2 | Tap Beebeeb → browse folders | Folders load with correct names + thumbnails |
| 6.3 | Drag a large file (≥ 200 MB) FROM somewhere ELSE (e.g., Downloads) TO the Beebeeb location | Upload progresses; file appears in Beebeeb; **the extension does NOT silently fail** (0427 fix for the 50 MB OOM). Use a 500 MB file if you have one. |
| 6.4 | Drag a file FROM Beebeeb to another location | File decrypts, copies out, plays/opens in the destination app |

---

## 7. Photos tab — fluidity (P1 — 0429)

| # | Step | Pass criterion |
|---|---|---|
| 7.1 | Upload 50+ photos to a folder (or use a fresh signup with a populated camera roll) | All thumbnails generate without crashes |
| 7.2 | Open Photos tab. Fast-flick the grid up and down repeatedly. | Scroll stays smooth (target ≥ 50 fps). No blank tiles for more than a fraction of a second. |
| 7.3 | Pinch the grid to change columns (2 / 4 / 7 / 12) | Columns change smoothly; thumbnails re-layout without flicker |
| 7.4 | Swipe between photos in preview | Adjacent photos load instantly (smart cache) |

---

## 8. App size & startup (P1 — 0426 / 0432)

| Metric | Expected | How to check |
|---|---|---|
| Installed size | ~30 MB (was 50 MB in build 102) | iOS Settings → General → iPhone Storage → Beebeeb → "App Size" |
| Cold launch | < 2 s to splash, < 4 s to Files tab | Stopwatch from tap → Files content visible |
| Office preview first-open | < 1 s extra latency on first PDF/DOCX/XLSX (then cached) | Subjective |

---

## 9. Two-factor auth + recovery (regression)

| # | Step | Pass criterion |
|---|---|---|
| 9.1 | Settings → Security → "Set up two-factor authentication" → scan QR with 1Password / Authy / Google Authenticator | TOTP code generates correctly. Beebeeb accepts the code. Backup codes are saved. |
| 9.2 | Sign out → sign in. Enter password. | 2FA prompt appears. Enter code. Login succeeds. |
| 9.3 | Sign out → sign in. Enter password + 2FA. Pretend to lose phone — tap "Use backup code". Enter one of the saved backup codes. | Login succeeds. The used code is invalidated (can't be reused). |

---

## 10. Android-only (47708a0 — Android testers only)

| # | Step | Pass criterion |
|---|---|---|
| 10.1 | Install on Android via Google Play Beta | App launches |
| 10.2 | Settings → Apps → Beebeeb → permissions | Only the permissions Beebeeb genuinely needs are listed. **RECORD_AUDIO and SYSTEM_ALERT_WINDOW must be ABSENT.** |
| 10.3 | Trigger an Android device backup (Settings → System → Backup) | Beebeeb's app data is NOT backed up to Google (`allowBackup=false`). Confirm via `adb shell dumpsys backup` output if you have ADB. |

---

## Known gaps in this build (be honest)

These were merged in but were NOT verified end-to-end before submission:

1. **0447 sessionToken round-trip** — the migration code is structurally identical to 0430's verified-working pattern, but the simulator can't exercise it (empty entitlements detach the App Group container). §4.1 is the in-field validation.
2. **0438 fast-path 100 MB benchmark** — code is shipped, but a real >60% latency-reduction measurement vs the per-chunk legacy path is still owed. Eyeball test (§3.4) is what we have.
3. **0429 2000-photo FPS** — we haven't seeded a 2000-photo library. §7.2 fast-flick on a populated library is the closest proxy.
4. **Share extension end-to-end** (§4.2) is the most uncertain — simulator pixel-clicks weren't reliable, so the iOS share-sheet path has only been verified statically (entitlements + activation rules). Real-device confirmation is exactly this section.

---

## How to report a failure

If something doesn't work:

1. **What you tested** (which numbered step above)
2. **What you saw** (screenshot if visual, exact text if alert)
3. **Device + iOS version** (Settings → General → About)
4. **Build number** (Beebeeb → Settings → About → Build)
5. **Reproducibility** — does it happen every time, or once?

Post to the team channel or DM. Thanks!
