// Pure recovery-phrase parsing + unlock-copy helpers for RecoveryUnlockScreen
// (task 1428). Kept dependency-free (no React/RN imports) so the logic can be
// unit tested directly instead of through a rendered screen.

export const RECOVERY_WORD_COUNT = 12;

/**
 * Normalize raw phrase input: trim, lowercase, and collapse ANY run of
 * whitespace — spaces, tabs, newlines, and the non-breaking / ideographic
 * space characters an iPad IME (e.g. a Japanese system keyboard, per the
 * reviewer's device) can insert — to a single space. This is what lets the
 * counter accept a pasted whole phrase, capitalized words, multi-line paste,
 * double spaces, and a trailing space identically to careful manual typing.
 */
export function normalizePhrase(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The individual words of a (possibly messy) phrase, after normalization. */
export function wordsFromPhrase(value: string): string[] {
  const normalized = normalizePhrase(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * What the primary "Unlock vault" button should say. A silently-disabled
 * button with no explanation is what Apple's reviewer described as
 * "unresponsive when tapped" — this makes the disabled state say why.
 */
export function unlockButtonLabel(wordCount: number): string {
  if (wordCount === RECOVERY_WORD_COUNT) return 'Unlock vault';
  if (wordCount === 0) return `Enter your ${RECOVERY_WORD_COUNT}-word phrase`;
  if (wordCount > RECOVERY_WORD_COUNT) {
    const extra = wordCount - RECOVERY_WORD_COUNT;
    return `${extra} word${extra === 1 ? '' : 's'} too many`;
  }
  const remaining = RECOVERY_WORD_COUNT - wordCount;
  return `${remaining} more word${remaining === 1 ? '' : 's'} needed`;
}

export class UnlockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnlockTimeoutError';
  }
}

/**
 * Bounds an async call so a hung native bridge (crypto.unlock has no network
 * call — recovery-phrase derivation is local — but a stuck FFI/keychain call
 * is indistinguishable from the outside) surfaces a typed, actionable error
 * instead of spinning forever. Apple's second rejection reported the screen
 * "still unresponsive when we attempted to sign in" after the phrase was
 * accepted.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UnlockTimeoutError(timeoutMessage)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
