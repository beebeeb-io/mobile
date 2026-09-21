# App Store privacy nutrition labels — reconciled against the code

**Status:** reconciled 2026-09-13 (task 1402) · **Scope:** iOS app only (`io.beebeeb.app`)
**Method:** every answer below is backed by a `file:line` citation in this repo, not the marketing
copy in `docs/app-store-listing.md`. Where the two disagreed, `docs/app-store-listing.md` was
corrected in the same pass (task 1402) and that correction is noted inline.

This is the source document for filling in App Store Connect → App Privacy. Enter it exactly —
do not re-derive it from the listing doc, which is marketing copy, not the audit trail.

## Method

1. Every third-party SDK category App Review cares about (analytics, crash reporting, ads,
   attribution) was checked directly against `package.json` dependencies and a repo-wide grep —
   not assumed absent because "we don't use those."
2. Every outbound network call that could carry personal data was traced to its call site in
   `src/lib/api.ts` and the native upload/backup managers.
3. `ios/Beebeeb/PrivacyInfo.xcprivacy` (Apple's separate "required reason APIs" manifest, not the
   ASC nutrition label, but a second independent signal) was read as a cross-check: it already
   declares `NSPrivacyCollectedDataTypes` as an **empty array**, which is only consistent with the
   findings below.

## No analytics / crash / ad SDK — the finding that corrects the listing doc

```
grep -rniE "sentry|crashlytics|bugsnag|amplitude|segment|mixpanel|firebase|analytics|posthog|instabug|appcenter|datadog" \
  repos/mobile/package.json repos/mobile/src
```

Zero real hits (`package.json` dependencies list: see the file directly — 51 packages, all Expo
modules, React Navigation, UI/rendering libs, none of the above); the "analytics"/"segment" string
hits inside `src/` are all the `GlassSegment` UI component and file-path segments, not the SDK
category.

**`docs/app-store-listing.md` §11 previously declared, under "Data Not Linked to You": "Diagnostics
→ Crash Data — anonymous crash reports to fix bugs."** There is no crash-reporting library in this
app. That line was false and has been corrected in the same commit-set as this doc (uncommitted in
the workspace primary — see the lead's PR). **Do not check any Diagnostics box in App Store
Connect.**

## Data types to declare

### Contact Info → Email Address (Linked to You)

Two distinct flows both send an email address to the server in plaintext:

1. **The account holder's own email** — account creation, sign-in, and the OPAQUE password
   protocol's login-start message.
   - `src/lib/api.ts:369-370` — `signup(email, password)` → `POST /api/v1/auth/signup { email, password }`
   - `src/lib/api.ts:375-379` — `login(email, password)` → `POST /api/v1/auth/login`
   - `src/lib/api.ts:2198-2213` — `opaqueLoginStart(email, password)` sends `{ email, client_message }`
   - Purpose: **App Functionality** (account creation, authentication). Not used for tracking, not
     shared with third parties, not used for advertising.

2. **A share recipient's email address** — when the signed-in user shares a file, they type the
   recipient's email and it is sent to the server in plaintext so the server can notify that
   person; the file name and encryption keys in the same request are ciphertext.
   - `src/lib/api.ts:2005-2014` — `createInvite(fileId, recipientEmail)` → `POST
     /api/v1/shares/invites { file_id, recipient_email }` (compare `file_name_encrypted`,
     `encrypted_file_key` on the same `ShareInvite` type, `api.ts:1977-1996` — those fields ARE
     ciphertext; `recipient_email` is not)
   - Purpose: **App Functionality** (share delivery). This is data about a person who may not be
     the app's user — declare it under the same Contact Info → Email Address type; App Store
     Connect does not have a separate "email of someone else" category, and Apple's guidance
     doesn't exempt data entered by the user about a third party.

### Identifiers → Device ID (Linked to You)

- A canonical per-device UUID, and — once notification permission is granted — the Expo/APNs push
  token, are registered with the server.
  - `src/lib/device-registration.ts:79-84` — `registerClientDevice({ hostname, platform,
    bb_version, push_token })`
  - `src/lib/push-notifications.ts:122-132` — `getExpoPushTokenAsync` → `registerDeviceToken({
    token, platform, device_id, client_device_id })`
- Purpose: **App Functionality** — push delivery, and the account's device-management list
  ("forget this device" in Settings, session/device audit). Not used for tracking across apps, not
  shared with third parties, not used for advertising.
- Silently skipped when the user declines the notification permission or is on a simulator
  (`push-notifications.ts:100,114-117` — `Device.isDevice` guard and permission-denied early
  return); `registerClientDevice` itself runs regardless of notification permission (device
  listing works even with notifications off), but the push-token field is simply omitted.

## Data NOT collected (declare "Data Not Collected" — do not check these boxes)

All of the following are encrypted **client-side, before the network call**, using the shared
Rust `ChunkEncryptorHandle` primitive (`repos/mobile/CLAUDE.md` → "Crypto"); the server receives
only ciphertext it cannot decrypt, and beebeeb's architecture is that no plaintext of these types
is ever readable server-side:

| Data type | Why it's "not collected" | Citation |
|---|---|---|
| File contents | Encrypted client-side before any network call; plaintext never leaves the device in readable form | `repos/mobile/CLAUDE.md` "Manual uploads are native too" — `NativeManualUploader.swift` / `ChunkEncryptorHandle.fromFile`; "Plaintext never enters the JS heap." |
| File / folder names, sizes | Names are separately encrypted fields (`file_name_encrypted`, `encrypted_folder_key` — see `api.ts:1985-1996`); sizes are stored but not personal/identifying content | `src/lib/api.ts:1985-1996` |
| Photos / videos (camera-roll backup) | Same `NativeEncryptedBackupUploader` pipeline as manual uploads | `modules/beebeeb-crypto/ios/PhotoBackupManager.swift`, `repos/mobile/CLAUDE.md` "Native backup path (task 0631)" |
| Contacts | Exported to a vCard, then routed through `NativeEncryptedBackupUploader.shared.upload(...)` — encrypted before the HTTP call | `modules/beebeeb-crypto/ios/ContactsBackupManager.swift:96,171` |
| Calendar entries | Same pipeline | `modules/beebeeb-crypto/ios/CalendarBackupManager.swift:92,296` |

Also not collected, confirmed by the absence of any code path that reads or transmits them:

- Location (no `expo-location` dependency, no `CLLocationManager` usage found)
- Advertising identifiers (no ad SDK; no IDFA/ATT usage found — `App Tracking Transparency` prompt
  is correctly absent because there is nothing to ask permission for)
- Browsing history, search history used for tracking (the app's own in-app file search does not
  leave the device as a "search history" product — it queries the user's own file index)
- Health, fitness, financial data
- Sensitive personal information
- Usage Data / Diagnostics (Crash Data, Performance Data, Other Diagnostic Data) — no SDK, see above
- Purchases — no In-App Purchase exists in the app at all (see task 1400; `grep -rniE
  "storekit|react-native-iap|in.?app.?purchase" repos/mobile/src repos/mobile/package.json` → 0 hits)

## Reminders — resolved (task 1446, 2026-09-21)

`app.json` declared `NSRemindersUsageDescription` and `NSRemindersFullAccessUsageDescription`
(formerly `app.json:32-33`, mirrored into `ios/Beebeeb/Info.plist`), but there was **no
Reminders-backup feature in the code** — `grep -rniE "reminder" src` (excluding the unrelated
`GlassSegment` UI false-positive) returned nothing beyond these two permission strings, and a
targeted re-check for `EKEntityTypeReminder`/`EKReminder`/`requestRemindersPermissionsAsync`
across `src`, `modules`, and `targets` confirmed there was no EventKit Reminders code path at all
— `expo-calendar` is used only for Calendar permissions. This was dead permission surface: the app
declared an intent (Reminders access) it never acted on. It didn't change the privacy label (an
unused, never-triggered permission collects nothing), but App Review can flag a usage-description
string that never corresponds to an actual permission prompt. Task 1446 removed both keys from
`app.json` and `ios/Beebeeb/Info.plist` (the only Info.plist that carried them — extension targets
never did); no test or script asserted these keys, so nothing else needed updating.

## Tracking

**Data Used to Track You: None.** Beebeeb does not use the Advertising Identifier, does not use
any third-party advertising/analytics SDK (see the finding above), and does not share any of the
data types above with third parties for their own advertising purposes. App Tracking Transparency
prompt: **not shown, correctly** — there is nothing that requires it.

## Summary table for App Store Connect data entry

| Category | Data type | Linked to user? | Used for tracking? | Purpose |
|---|---|---|---|---|
| Contact Info | Email Address (account holder) | Yes | No | App Functionality |
| Contact Info | Email Address (share recipient) | Yes (tied to the sharer's account action) | No | App Functionality |
| Identifiers | Device ID | Yes | No | App Functionality |
| Diagnostics | Other Diagnostic Data (server-side failed-request capture keyed by user id; per-upload client name + version) | Yes | No | App Functionality — added 2026-09-21, see the reconciliation update below |
| Other Data | IP address in `audit_log` / `share_invite_activity` (server-side, security/audit) | Yes | No | App Functionality — checkbox choice flagged to Guus, see below |
| — | Everything else | — | — | Not Collected |

## Reconciliation update — 2026-09-21 (lead gate on this document; mobile main d47342f, server main 1c082ac)

**Citation drift (fixed here, the claims themselves still hold):** `src/lib/api.ts` moved. `signup` is now at
`api.ts:449`, `login` at `api.ts:455`, `opaqueLoginStart` at `api.ts:2284` (this doc's `369-370`, `375-379`,
`2198-2213` were the 2026-09-13 lines). `device-registration.ts:79-84` and `push-notifications.ts:122-132`
still resolve to `registerClientDevice` and `getExpoPushTokenAsync`.

**Correction, left visible:** the section "No analytics / crash / ad SDK" ends with "**Do not check any
Diagnostics box in App Store Connect.**" That was written against the *client* and is still true for
crash/analytics SDKs (none), but Apple's labels cover data the developer collects from the app **including
server-side**, and two server-side collections exist that are linked to the user:

1. **Failed-request diagnostics keyed by user id.** `repos/server/beebeeb-api/src/error_capture.rs:71-81`
   resolves the user id from the request's bearer token and stores an `error_events` row for every failed
   API call (`db.rs:2235-2245`: `source, category, error_code, http_status, endpoint, user_id, request_id,
   detail`), pruned by `error_events_cleanup.rs` (default retention 90 days, boot log
   "retention 90d"). No stack traces from the device, no device model, no crash reports — but it is
   diagnostics data linked to an identifiable account.
2. **Writer provenance per upload.** Since mobile PR #96 (2026-09-19) every request from `src/lib/api.ts`
   carries `X-Beebeeb-Client: mobile-ios` and `X-Beebeeb-Client-Version: <app version>`; the server stores
   them on every `object_versions` row (`created_by_client`, `created_by_client_version`;
   `repos/server/beebeeb-api/src/routes/uploads.rs`, `routes/files.rs`). Linked to the user through their
   files; used only to attribute which client build wrote a version (blast-radius queries).
   Native uploads (task 1439) will carry the same two headers once that lands.

→ **Declare:** Diagnostics → *Other Diagnostic Data* — **Linked to You** — purpose *App Functionality* —
not used for tracking. Crash Data and Performance Data stay **Not Collected** (no SDK; unchanged).

3. **IP addresses (server-side).** `audit_log.ip_address` (`db.rs:274`) and `share_invite_activity.ip_address`
   (`db.rs:818`) store the caller's IP for account-audit and share-activity rows. Apple's data-type list has
   no "IP address" entry; the honest placement is **Other Data Types → Other Data Types — Linked to You — App
   Functionality (security / audit)**. Which box to tick is a product/legal call → flagged to Guus in
   decision 1398 rather than chosen here.

**Consequence for App Store Connect:** the App Privacy answers entered from the 2026-09-13 table are
incomplete; the two rows added to the summary table above must be entered in ASC (App Privacy has no API;
Guus, see 1398). The Reminders dead-permission loose end above was resolved by task 1446.
