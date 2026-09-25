# TestFlight build 212 — P0 release (account-switch backup, billing honesty, lock-file, signup code)

**App version:** 1.0.0 • **Build:** 212 • **Branch:** `release/2026-09-25-testflight` off `main` `caa7385`

**Status as of 2026-09-25: NOT yet on TestFlight.** The ipa built and tested clean, but `eas submit`
was rejected — Apple's App Store Connect export-compliance declaration for this app (`35c912e6`) is
still `IN_REVIEW` (filed 2026-09-15; no code issued yet, blocking every upload since build 210). See
task `.claude/tasks/backlog/1447-*.md` for the live status and what unblocks it. This checklist is
ready for whenever a build actually reaches testers — note that build will most likely be numbered
213, not 212 (see 1447's notes), so re-confirm the build number before walking this file.

Four PRs since the last release, in merge order:

- **#107 — [P0] fix cross-account key reuse in native photo backup** (`fix/1531-account-switch-backup`)
- **#108 — iOS billing status honesty + remove dead Upgrade CTAs** (`fix/1540-sweep`)
- **#109 — fix Lock-file bypass (Photos + swipe pager), 2FA backup-codes guard, 2FA cancel, passphrase share links** (`fix/1539-sweep`)
- **#110 — signup via email code + signup ticket** (`feat/1551-signup-email-code`)

Walk this on a real iPhone after the build appears in TestFlight. Each check has a clear pass/fail signal. Capture screenshots where noted — those are what move the underlying tasks from `in-review/` to `verified/`.

---

## 1. Account-switch backup isolation (#107) — the P0

This is the most important check in this build. The bug: after switching accounts on-device, background photo/contacts/calendar backup could keep uploading the FIRST account's data into the SECOND account.

- [ ] **1.1** Sign in as Account A. Let camera backup run for at least one photo (confirm in Files/Photos tab that something uploaded).
- [ ] **1.2** Sign out of Account A. Confirm the app shows the signed-out screen (not just a session refresh).
- [ ] **1.3** Sign in as a *different* Account B. Add a new photo to the device's camera roll (or use an existing one not yet backed up).
- [ ] **1.4** Let backup run. In Account B's Files/Photos tab, confirm you see ONLY Account B's own content — nothing that belonged to Account A.
- [ ] **1.5** Sign back into Account A. Confirm Account A's library is unchanged — no stray uploads that originated from the Account B session.
- [ ] **1.6** Contacts-only backup: with a contacts-sync-enabled account, sign out mid-backup (or immediately after enabling), sign into a different account, and confirm no contacts from the first account appear under the second.

**Capture for verified/:** screenshots of both accounts' Files/Photos tabs after the switch, showing clean separation.

## 2. Billing honesty (#108)

- [ ] **2.1** On a trial account: Settings → Billing shows **"Trial ends `<date>`"** (an actual date, not a vague "trial active" string).
- [ ] **2.2** Cancel a subscription (or use an already-cancelled test account): billing shows **"Access until `<date>`"**.
- [ ] **2.3** Look for any **Upgrade button that does nothing** when tapped — there should be none. Every visible upgrade/billing CTA should navigate somewhere real.
- [ ] **2.4** Trigger a billing error path if you can (e.g. an expired card on a test account) — the error text should be a plain, readable sentence, not a raw error code or stack trace.

**Capture for verified/:** screenshot of the trial and/or cancelling billing screen showing the dated copy.

## 3. Lock file enforcement (#109)

- [ ] **3.1** Lock a file. Open it in single preview — it should require unlock (Face ID / passcode) before showing content.
- [ ] **3.2** Open the file preview **swipe pager** (swipe between multiple files where one is locked) — swiping onto the locked file must ALSO require unlock. This was the actual bypass: previously swiping in could show the locked file's content without prompting.
- [ ] **3.3** Photos tab: a locked photo should not be viewable/thumbnail-previewable without unlocking, consistent with the Files tab behavior.
- [ ] **3.4** Somewhere in the lock UI (Settings or the lock toggle itself) there should be an honest note that locking a file in Beebeeb does **not** lock it in the iOS Files app — if you've exposed the file there via Files app integration, this note should say so plainly.
- [ ] **3.5** 2FA setup: start enabling 2FA, then back out partway (don't finish scanning the QR / entering the code). Confirm you are NOT trapped — you can cancel/exit setup and the account is not left in a broken half-enabled state.
- [ ] **3.6** 2FA challenge (sign-in with 2FA already enabled): confirm the challenge screen has a working **Cancel** button that returns you to sign-in instead of being a dead end.
- [ ] **3.7** Passphrase-protected share link: create a share with a passphrase, open the link (as if you were the recipient), enter the passphrase — it should unlock and show the shared content.

**Capture for verified/:** screenshot of the swipe-pager unlock prompt (3.2) and the 2FA challenge Cancel button (3.6).

## 4. Signup via email code (#110)

- [ ] **4.1** Start signup with a fresh email address. After entering email + password, you should be asked to **verify the email with an 8-digit code** before the account is actually created.
- [ ] **4.2** Check the inbox for that email — an 8-digit code should have arrived. Enter it; signup should proceed to account creation.
- [ ] **4.3** Enter a wrong code once — should get a clear rejection, not a crash, and let you retry.
- [ ] **4.4** This is a client that falls back to the old signup flow if the server doesn't yet support ticketed signup — if you see the OLD flow (no email-code step) instead, that is expected fallback behavior, not a bug, **as long as account creation itself still works end to end**. Note which path you actually saw.

**Capture for verified/:** screenshot of the 8-digit code entry screen.

---

## How to flag a failure

If any check fails: capture a screenshot + step number and file it. Everything above traces to a specific merged PR (#107–#110) — a failure here means a regression against code already on `main`, not a work-in-progress feature.
