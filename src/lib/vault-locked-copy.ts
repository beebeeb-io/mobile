/**
 * Task 1704 slice 3 — canonical copy for the honest locked landing.
 *
 * `RecoveryUnlockScreen` is the mobile locked landing: `VaultRecoveryGate`
 * (App.tsx) routes there whenever the device holds no vault key — a fresh
 * device, a key purged on owner mismatch (1594), or the state after an
 * email-based password reset (1704 slice 1: sessions deleted, vault key
 * untouched). 1684/1693 (decision D-2026-10-02, option A — "net zoals in
 * iOS") fixed the language for this state on web with the canonical title
 * `Vault locked`, a brief honest explanation, and NO password form; this
 * module carries the same language on iOS (see DEVIATIONS.md → task 1704).
 *
 * The two-tier story stays explicit, because it is the core 1704 promise:
 * the PASSWORD unlocks the account; the 12-WORD RECOVERY PHRASE (the vault
 * key's portable encoding) is what unlocks the vault — the password alone
 * can never decrypt anything.
 *
 * Copy-only module: no imports, so tests pin the strings without pulling
 * React Native into the test process.
 */

/** Canonical locked-state title (1684/1693 parity). */
export const VAULT_LOCKED_TITLE = 'Vault locked';

/**
 * The landing's honest explanation. Names the state (the device does not
 * hold the vault key), the two tiers (password = account, phrase = vault),
 * and the one unlock path offered here (the 12-word recovery phrase).
 */
export const VAULT_LOCKED_LANDING_SUBTITLE =
  "This device doesn't hold your vault key. Your password unlocks your account — " +
  'your 12-word recovery phrase unlocks the vault. Enter it below to decrypt your files here.';