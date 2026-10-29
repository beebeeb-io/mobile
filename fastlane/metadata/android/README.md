# Google Play listing package (Android)

Prepared 2026-10-29 by the mobile lead for Guus, who captures the screenshots and submits.
Layout follows `fastlane supply` (`fastlane/metadata/android/<locale>/`), next to the iOS
`deliver` metadata in `fastlane/metadata/en-US/`. Nothing here is uploaded automatically.

| File | Play Console field | Limit | Now |
|---|---|---|---|
| `en-US/title.txt` | App name | 30 | 24 |
| `en-US/short_description.txt` | Short description | 80 | 72 |
| `en-US/full_description.txt` | Full description | 4000 | 1740 |
| `en-US/images/icon.png` | App icon | 512 x 512, 32-bit PNG with alpha | included (RGBA, opaque; full-bleed square, Play applies its own mask) |
| `en-US/images/featureGraphic.png` | Feature graphic | 1024 x 500, JPEG or 24-bit PNG, no alpha | included (RGB, dark: "Your files. Your keys." / "stored in Europe") |
| `en-US/images/phoneScreenshots/` | Phone screenshots | 2 to 8 | Guus captures, see below |

## Before you publish: four checks

The copy only claims what the code on `main` has. Three lines describe features that exist in the
code but that nobody has confirmed on an Android phone yet. Check each on your OnePlus and delete
the line from `full_description.txt` if it does not work:

1. "Unlock the app with your fingerprint or face" (Settings, app lock).
2. "Search your files".
3. "revoke it at any time" (Shared tab, a link you made).
4. "You need a Beebeeb account to use the app" stays true either way. If "Create account"
   works on Android, you can leave it; it does not say where to sign up on purpose (see Payments).

Not claimed, on purpose: **backup from the phone** (photos, contacts, calendar). On Android the toggles
call native functions the Android module does not have (`enablePhotoBackup`, `enableContactsBackup`,
`enableCalendarBackup`, `triggerImmediateBackup`: 0 registrations in `BeebeebCryptoModule.kt`), so turning
backup on fails. The port is task 0728; hiding the toggles until then is a separate task.

## What blocks a public (production) release, but not closed testing

- **Task 2220, the push decision.** The Android code asks Expo for a push token
  (`src/lib/push-notifications.ts`), which is Expo plus Google FCM, both US systems. The build has
  no FCM config, so push does not work on Android today. The task says to decide before a public
  release; the Data safety form follows the decision.
- **Task 2219, the public account-deletion page.** Play asks for a deletion URL that works
  without signing in.
- **Data safety form.** Draft answers: `.claude/tasks/verification-evidence/1754/play-review-notes-and-data-safety.md`
  (workspace repo). On Android, backup from the phone does not work yet (see above), so the app
  collects no gallery photos, contacts or calendar entries; re-check this when 0728 lands.
- **Public-claims canon.** `docs/canon/public-claims.md`, row "Android availability", says
  "Android in testing" and never "available on Google Play". When the listing goes public, the row
  is upgraded first (evidence: the public listing URL), then the site and READMEs.

## Payments (why the copy says nothing about plans or prices)

Cloud storage is a digital good under Play's Payments policy. The app has no purchase flow, and the
listing does not mention plans, prices, trials or where to pay. That keeps the listing inside the
policy without depending on how Play reads "go to our website" text (the open risk in the 1754 draft).

## Screenshots: what to capture on the OnePlus

Use the seeded demo account (the same kind of vault as the iOS `demo+ios@beebeeb.io` captures):
neutral file names, nothing personal, never your own vault. Dark mode, to match your 2026-10-22
choice for product images (switch the phone to dark before you start). Hide the status bar clutter
if you can (no carrier name, full battery).

Play's rules that matter here: PNG or JPEG, up to 8 MB, each side 320 to 3840 px, and the long side
at most twice the short side. A raw OnePlus capture is 20:9 (for example 1080 x 2400), which is MORE
than twice and will be rejected as is. Play's recommendation slots also want 9:16 portrait screenshots
of at least 1080 px (at least 4 of them). So: send me the raw captures and I frame each one to
1080 x 1920 (9:16), caption above the screen, the way the iOS set is framed
(`scripts/generate-app-store-screenshots.mjs`). Do not crop them yourself: a plain crop to 9:16 cuts
480 px of the screen.

| # | Screen to capture | How to get there | Caption (eyebrow / headline / line) |
|---|---|---|---|
| 1 | Files, root folder with 6 to 8 items, a mix of folders and files | Files tab, list view | END-TO-END ENCRYPTED / Your files, encrypted / Every file and folder name is encrypted on your phone before upload. |
| 2 | A photo or PDF open in preview | tap a file | DECRYPTED ON YOUR DEVICE / Opened on your phone / Previews decrypt locally. We only ever store ciphertext. |
| 3 | The share sheet for a file, with a password typed (dots) and an expiry chosen | three dots on a file, Share Beebeeb link | ENCRYPTED LINKS / Share without handing over the key / The key stays in the link. Add a password or an expiry date. |
| 4 | Photos tab, scrolled into a month with a full grid | Photos tab | YOUR PHOTOS / Your photos, by date / Photos stay encrypted until they open on your phone. |
| 5 | A file request link just created, ready to share | a folder, File request, Create & share link (stop at the share sheet, do not send) | FILE REQUESTS / Let others send you files / Collect files into a folder from anyone with the link. |
| 6 | A ZIP archive open, showing its folder tree | tap a .zip in the demo vault (upload a small one with neutral names first if there is none) | PREVIEW MORE / Look inside archives / Open ZIP files and the files inside them, on your phone. |
| 7 | Settings, the app lock section with fingerprint unlock on | Settings | APP LOCK / Locked when you're away / Unlock with your fingerprint or face. |
| 8 | Settings, the storage location row showing Europe or the country | Settings, Storage location | STORED IN EUROPE / Your vault stays in the EU / Encrypted on your phone, stored in Europe. |

Order on the listing: 1, 3, 4, 2, 8, 5, 6, 7 (encryption, sharing and photos first). Drop 7 if check 1 above fails;
six screenshots is plenty.

Never capture: the recovery phrase screen (it blocks screen capture on purpose), any real email
address, the sign-in screen with a typed password, or a notification from another app.

## Copy rules this follows

- Headline "Stored in Europe" (Guus, 2026-09-26). No city, no provider, no region choice
  (workspace `CLAUDE.md`, EU references). No "Dutch company" (Guus, 2026-10-22).
- Honest over reassuring: the listing says up front that we cannot recover files without the
  password or the recovery phrase.
- "Audited" only in the negated form ("not yet audited externally"), per the public-claims canon.
- No emojis, no "best" or "#1", no testimonials, no prices.
