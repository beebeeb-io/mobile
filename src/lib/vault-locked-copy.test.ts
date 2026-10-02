// @ts-nocheck
/**
 * Task 1704 slice 3 — the honest locked landing carries the canonical
 * "Vault locked" language (1684/1693, decision D-2026-10-02 option A: "net
 * zoals in iOS"; 1693 shipped the canonical title `Vault locked` on web for
 * iOS parity — "brief honest explanation, NO password form").
 *
 * `RecoveryUnlockScreen` is that landing on mobile: the VaultRecoveryGate
 * routes there whenever the device holds no vault key (fresh device, a key
 * purged on owner mismatch, or the post-password-reset state). The copy lives
 * in `./vault-locked-copy` so it is pinnable without a React renderer (this
 * repo has none); the screen is pinned to actually RENDER those constants by
 * scanning its source — the same source-scan precedent as
 * `src/components/sheet/sheet-sweep.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { VAULT_LOCKED_LANDING_SUBTITLE, VAULT_LOCKED_TITLE } from './vault-locked-copy';

describe('1704 — RecoveryUnlockScreen uses the canonical "Vault locked" landing language', () => {
  test('canonical title (1684/1693 parity)', () => {
    expect(VAULT_LOCKED_TITLE).toBe('Vault locked');
  });

  test('honest two-tier subtitle: password = account, 12-word phrase = vault', () => {
    // Names the phrase as THE vault-unlock path…
    expect(VAULT_LOCKED_LANDING_SUBTITLE).toContain('12-word recovery phrase');
    // …and keeps the account/vault tier split honest.
    expect(VAULT_LOCKED_LANDING_SUBTITLE).toContain('password');
    // Never implies the password can decrypt the vault (1704 core promise).
    expect(VAULT_LOCKED_LANDING_SUBTITLE).not.toMatch(/password (unlocks|opens) your vault/i);
  });

  test('RecoveryUnlockScreen renders these constants and no longer the old heading', async () => {
    const src = await Bun.file(new URL('../screens/RecoveryUnlockScreen.tsx', import.meta.url)).text();
    expect(src).toContain('VAULT_LOCKED_TITLE');
    expect(src).toContain('VAULT_LOCKED_LANDING_SUBTITLE');
    // The old heading is gone from the landing (other screens' unrelated
    // "Unlock your vault" alerts are untouched and live in other files).
    expect(src).not.toContain('>Unlock your vault<');
  });
});