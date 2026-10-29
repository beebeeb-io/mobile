/**
 * Bounds on values the onboarding document is allowed to dictate (task 1746, 1753
 * pass 2). The document is server-supplied; a client that trusts a number or a
 * link blindly lets a compromised or buggy server reshape the UI. Pure: no React,
 * no native modules, no `URL` global.
 */

/**
 * The recovery phrase length `beebeeb_core` generates (`RECOVERY_WORD_COUNT`, BIP39,
 * fixed in core). The ceremony cannot be asked for another length, so a document
 * that declares a different `recovery_phrase.word_count` is a version this build
 * cannot honour: signup is refused rather than shown a number it will not deliver.
 */
export const CORE_RECOVERY_WORD_COUNT = 12;

export function phraseWordCountSupported(declared: number): boolean {
  return declared === CORE_RECOVERY_WORD_COUNT;
}

export const CODE_LENGTH_MIN = 4;
export const CODE_LENGTH_MAX = 12;

/** The email-code length is the server's to declare, within 4..12 (a UI of 10 000 boxes is not a code). */
export function clampCodeLength(n: number): number {
  if (!Number.isFinite(n)) return CODE_LENGTH_MAX;
  return Math.min(CODE_LENGTH_MAX, Math.max(CODE_LENGTH_MIN, Math.trunc(n)));
}

const BEEBEEB_HTTPS_RE = /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*beebeeb\.io(?::443)?(?:[/?#][^\s]*)?$/;

/** An `https:` link whose host is `beebeeb.io` or a subdomain of it. Anything else is not ours to open. */
export function isBeebeebHttpsUrl(v: unknown): v is string {
  return typeof v === 'string' && BEEBEEB_HTTPS_RE.test(v);
}

/**
 * The Terms version to RECORD: the one the accept_terms step displayed (its
 * `params.version`, falling back to `policy.terms.version`). The same value is
 * what register-finish must submit, so what was read is what is recorded.
 */
export function shownTermsVersion(stepParams: Record<string, unknown>, policyVersion: string): string {
  const v = stepParams.version;
  return typeof v === 'string' && v.length > 0 ? v : policyVersion;
}
