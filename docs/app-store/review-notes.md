# App Review notes, age rating, category, export compliance

**Status:** drafted 2026-09-13 (task 1402) · **Scope:** iOS submission for `io.beebeeb.app` v1.0.0

## Submission dependencies — read this before using this document

This document describes the **target submission state**, not today's `main`. Three sibling tasks
must land before the app is actually submitted, and this doc says so at each relevant point instead
of pretending they're done:

| Task | What it changes | Status as of 2026-09-13 |
|---|---|---|
| 1400 | Removes the tappable billing/upgrade CTAs from `StorageScreen.tsx`; sets `supportsTablet: false` + `TARGETED_DEVICE_FAMILY = 1` on every target | **implemented, PR open** (`feat/1399-app-review-compliance`) — not yet merged to `main` |
| 1399 | In-app account deletion (replaces the "Delete on web" alert in `PrivacyScreen.tsx`) | **implemented, PR open** (`feat/1399-app-review-compliance`) — not yet merged to `main` |
| 1401 | Flips `ITSAppUsesNonExemptEncryption` to `true`; writes `docs/export-compliance.md` | **implemented, PR open** (`feat/1399-app-review-compliance`) — not yet merged to `main` |

The reviewer walkthrough and the "no purchases in-app" / "deletion is in-app" claims below are
written for the build that ships once this PR merges — do not attach this document to a build that
predates it. Verify the merge landed (`git log main` for the PR's squash/merge commit) before
attaching this file to an actual App Review submission.

## 1. Reviewer walkthrough

Beebeeb is an end-to-end-encrypted cloud storage app. The company (Initlabs B.V., the server, and
the reviewer's own device) can never see a signed-in user's file contents, filenames, photos,
contacts, or calendar entries — everything is encrypted on-device before it is ever sent. This
walkthrough exists so the reviewer isn't surprised by that when they can't "just look at" a file
from an admin angle — there is no such angle.

**Sign-up (recovery phrase step, ~1 minute):**
1. Tap "Create account," enter an email and password. Password auth uses the OPAQUE protocol — the
   password itself never reaches the server, only a zero-knowledge proof of it
   (`src/lib/api.ts:2198-2266`).
2. The app then shows a **12-word recovery phrase** (`OnboardingScreen.tsx:452`, BIP39, generated
   by the Rust core — `repos/core/CLAUDE.md:7`) with the copy: *"These 12 words are the ONLY way to
   recover your vault if you lose access. Write them down."* Screenshots/screen-recording are
   blocked while this screen is visible (`OnboardingScreen.tsx:72`).
3. The user re-enters a few of the words to confirm they saved it, then lands in the app.
4. **This is why account recovery cannot be done by Beebeeb support**: the recovery phrase (or the
   password, which wraps it) is the only key. If both are lost, the data is unrecoverable by
   design — including by us. This is disclosed in the app's own copy and in the App Store
   description ("If you forget your password, we cannot recover it. We will not pretend
   otherwise.").

**Why the server cannot show the reviewer decrypted files:** all file content, filenames, photos,
contacts, and calendar entries are encrypted **client-side** before any network call, using a
shared streaming primitive (`ChunkEncryptorHandle`, implemented in the Rust core and called from
Swift — see `repos/mobile/CLAUDE.md` → "Crypto"). The server stores ciphertext it cannot decrypt.
There is no admin panel, debug flag, or support tool that decrypts a user's data — the master key
never leaves the device/keychain (`repos/core/CLAUDE.md:22`).

**Permission prompts the reviewer will see, and why (each is opt-in / feature-gated, not
requested at launch):**

| Permission | `Info.plist` string | Trigger |
|---|---|---|
| Photos (read) | "Beebeeb backs up your photos with end-to-end encryption." | Settings → turn on Photo Backup, or Photos tab first use |
| Photos (add) | "Beebeeb saves downloaded photos to your library." | Saving a downloaded photo back to the camera roll |
| Contacts | "Beebeeb backs up your contacts with end-to-end encryption." | Settings → turn on Contact Backup (`SettingsScreen.tsx:225-231`) |
| Calendar | "Beebeeb backs up your calendar with end-to-end encryption." | Settings → turn on Calendar Backup |
| Camera | "Beebeeb scans the amber constellation pattern to pair a new device." | **Two features share this string**: (a) pairing a new device by scanning an on-screen pattern (`ConstellationScannerScreen.tsx`), and (b) the in-app document scanner that adds a scanned page to the encrypted vault (`DocumentScannerScreen.tsx`). Neither uploads anything until the user explicitly saves. |
| Face ID | "Allow Beebeeb to use Face ID" (`ios/Beebeeb/Info.plist:75`, via the `expo-local-authentication` config plugin) | Settings → Security → enable Face ID lock |
| Notifications | (system prompt, no custom string) | First login, for upload-complete / share-received alerts; declining it just means no push (`push-notifications.ts:114-117`) |

**Known dead permission string (flagged, not a reviewer-facing risk but worth knowing):**
`NSRemindersUsageDescription` / `NSRemindersFullAccessUsageDescription` are declared but there is
no Reminders-backup feature in the app — the prompt is never triggered. See
`docs/app-store/privacy-labels.md` → "Reminders — an open loose end."

**No purchases in the app** (post-1400): the Storage screen shows the account's current plan and
usage as read-only facts. Managing or upgrading a plan happens on the web
(`app.beebeeb.io/settings/billing`, `beebeeb.io/pricing`) — the app does not open those URLs itself
(1400 removes the two `Linking.openURL` calls) and presents no button, link, or other call to
action that leaves the app for a purchase. There is no In-App Purchase product configured for this
app at all.

**Account deletion is in-app** (post-1399): Settings → Privacy → "Delete my account" opens an
in-app flow (not a web redirect): an irreversibility explanation, a typed `DELETE` confirmation,
the account password, a step-up confirmation, then the account and all associated data are
destroyed server-side. See task 1399 for the exact flow.

**Reviewer account:**

> `[PLACEHOLDER — do not fill in without Guus's explicit go-ahead, decision 1398 §6]`
> `Email: `
> `Password: `
>
> Creating this account is a **production mutation** and is gated on Guus's word per decision 1398
> §6: either he says "create it" (the lead signs up through the public app and records the
> credentials) or he creates it himself. Either way, the filled-in credentials — and the notes text
> above once it quotes the account's 12-word recovery phrase for the reviewer walkthrough — go into
> a **copy of this file kept OUTSIDE the repo**, never into this tracked placeholder (this file is
> **not** gitignored, so anything written here goes straight into git history). The `deliver_metadata`
> lane (`repos/mobile/fastlane/Fastfile`) reads that external copy at upload time via the
> `ASC_REVIEW_NOTES_PATH` environment variable (its `notes` field is `File.read(ENV["ASC_REVIEW_
> NOTES_PATH"])`) plus `ASC_REVIEW_FIRST_NAME` / `ASC_REVIEW_LAST_NAME` / `ASC_REVIEW_PHONE` /
> `ASC_REVIEW_EMAIL` / `ASC_REVIEW_DEMO_USER` / `ASC_REVIEW_DEMO_PASSWORD` for the rest of the
> `app_review_information` hash. This placeholder in the repo must stay exactly as written above —
> never edit it in place to hold real credentials.

**Signing in with the demo account (the reviewer's path — iOS, as of mobile `main` 2026-09-25):**

These are the screens the iOS app actually shows. They were checked against a Release build on an
iPhone simulator with the demo account (task 1557, Maestro run: "Unlock your vault" visible,
"Set up this device" not shown). The credentials and the 12-word phrase live only in the private
notes copy that `ASC_REVIEW_NOTES_PATH` points at, never here.

1. Launch the app. The sign-in screen opens. Enter the demo email and password and tap **Sign in**.
2. If iOS asks about notifications, either answer works.
3. The app opens **"Unlock your vault"**. The vault key never leaves a device that holds it, so a
   new device unlocks with the recovery phrase. Tap the large text box and type or paste the 12
   words (lowercase, single spaces). The counter reads **"12/12 words"**.
4. Tap **Unlock vault**. The Files screen opens.

The iOS app does **not** show a "Set up this device" chooser (passkey / QR / recovery phrase).
That screen exists only in the web app (`repos/web/src/components/device-provision.tsx`). The
private review notes submitted in September 2026 described it. Keep the private notes on the
four steps above.

**Which build may be attached to a submission (task 1557, 2026-09-25):**

Apple's 2026-09-25 rejection ("unable to login: tapped login → error message", iPad Air M3,
iPadOS 27) was a re-test of **build 141**. That build is from May 2026 and was still attached to
review submission `6c8670cc`. Build 141 finishes OPAQUE login with the legacy Identity KSF and
ignores the `ksf_version` that login-start returns. Every account registered since 2026-05-23 is
KSF v1 (Argon2id), and that includes the demo account created 2026-09-13. For those accounts the
envelope cannot open on the device, so the app shows an error before it ever sends login-finish.
Our production server logs show no failed login attempt for this rejection, which is consistent
with the client never reaching login-finish. The server cannot fix this: the KSF runs on the
client, and re-registering the demo account under v0 would switch off password stretching.

Rules for any future submission:

- **Never re-submit build 141 or anything below the dual-KSF client (mobile `29dffa9`, build 164).**
  The regression test `src/lib/api.opaque-ksf-threading.test.ts` pins the contract: a v1 account
  must reach the native finish with `ksf_version = 1`, a v0 account with 0, and an absent field
  must default to 1.
- **Do not attach builds 205–208 either** (uploaded 2026-08-31). They are older than tasks 1399
  (in-app deletion), 1400 (iPhone-only, no billing CTAs) and 1401
  (`ITSAppUsesNonExemptEncryption = true`). Submitting one would reopen those review items and
  make a false export declaration.
- The next submittable build is the first one from `main` that carries
  `ITSEncryptionExportComplianceCode` (task 1447; EAS will number it **213**).
- Before submitting, sign in on an iPhone simulator with the demo account against production, all
  the way to the Files screen. With `supportsTablet: false`, iPad runs the app in iPhone
  compatibility mode. Apple reviews on iPad, so repeat the sign-in on an iPad simulator and take
  `simctl` screenshots, because Maestro's hierarchy is empty on iPad simulators on this Mac.

## 2. Age rating questionnaire (Apple's current content-rights questionnaire)

Beebeeb is a private file-storage utility with no user-facing content the app itself produces or
moderates — the answers below follow directly from that:

| Question | Answer | Why |
|---|---|---|
| Cartoon or Fantasy Violence / Realistic Violence / Sexual Content or Nudity / Profanity or Crude Humor / Alcohol, Tobacco, or Drug Use / Mature or Suggestive Themes / Horror or Fear Themes / Medical/Treatment Info | None | The app has no editorial content; it stores whatever the user uploads, encrypted, and never displays or promotes any of it |
| Gambling and Contests / Simulated Gambling | No | Not present |
| Unrestricted Web Access | **No** | Every `WebView` in the app renders a **locally generated HTML string**, never an arbitrary external URL: `DevicePairingShowScreen.tsx:33-34`, `ConstellationSendScreen.tsx:248-249`, `CodeRenderer.tsx:154-156`, `DocxRenderer.tsx:146-149` all pass `source={{ html }}` with an in-memory string, not `source={{ uri }}` to a remote address. There is no in-app browser. |
| User-Generated Content (in Apple's shared/public-content sense — forums, chat, publicly visible posts) | **No** | Files, photos, contacts, and calendar entries are private and end-to-end encrypted for the account holder; nothing is published, searchable, or visible to other users except a deliberate, explicit share action to a named recipient (not public UGC in the sense this questionnaire item targets) |
| Message Board / Chat | No | No messaging feature exists |
| Frequent/Intense content of any kind | No | n/a |

**Resulting rating: 4+**, matching `docs/app-store-listing.md`'s existing "Age rating: 4+" line —
this pass confirms it against the questionnaire rather than assuming it.

## 3. Category

- **Primary:** Productivity
- **Secondary:** Utilities

Matches `docs/app-store-listing.md` §12 and the header metadata line — no change needed.

## 4. Export compliance — see `repos/mobile/docs/export-compliance.md`

Task 1401 is implemented (PR `feat/1399-app-review-compliance`): `repos/mobile/docs/export-compliance.md`
is now the source of truth for the questionnaire answers and the code-cited algorithm inventory.
This section is kept short so the two documents don't drift:

- `app.json` and `ios/Beebeeb/Info.plist` both now carry `ITSAppUsesNonExemptEncryption: true` —
  beebeeb's AES-256-GCM / Argon2id / OPAQUE are standard, published algorithms, but they run in the
  Rust core via UniFFI, not through CryptoKit/CommonCrypto, so the OS-built-in exemption does not
  apply.
- **Do not submit for App Review before this PR merges** — a build with the key still `false` would
  be a materially false declaration to Apple, not just an internal inconsistency.
- Once this PR merges and Apple issues an `ITSEncryptionExportComplianceCode` (after the ASC
  questionnaire is answered once), decision 1398 §6 names the one remaining Guus-facing step (paste
  the code into `app.json` + `export-compliance.md` §4, or authorize the lead to do it once the ASC
  API key exists).
- This document's review-notes narrative above ("why the server cannot show files") is consistent
  with 1401's inventory in spirit — both describe the same client-side AES-256-GCM/Argon2id/OPAQUE
  stack — but 1401's file is the one with file:line citations into `repos/core` and the actual ASC
  answers; this document does not duplicate that inventory.

## Notes for whoever runs the actual `deliver` upload

This document and `docs/app-store/privacy-labels.md` are meant to be pasted into App Store Connect
by hand (age rating, category, and privacy labels aren't part of `fastlane deliver`'s metadata
upload — only `fastlane/metadata/**/*.txt` fields are, plus the review-information fields below).
The `deliver_metadata` lane in `repos/mobile/fastlane/Fastfile` pushes the text fields + screenshots
and, when `ASC_REVIEW_DEMO_USER` is set, the App Review contact + demo account + notes (see
"Reviewer account" above for the exact env vars, and `ASC_REVIEW_NOTES_PATH` for where the filled
notes text — including the recovery phrase — is read from, outside this repo). It does not touch
age rating, category, or privacy labels — those still go in by hand.

Non-interactive runs (no TTY to answer the HTML-diff confirmation) set `DELIVER_FORCE=1`; an
ordinary interactive run leaves it unset and gets the confirmation prompt as before.
