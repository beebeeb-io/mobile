/**
 * Task 1563 — pure decision for whether an already-loaded text file may be
 * edited. "UTF-8 text <= 2 MB is editable; larger or non-UTF-8 files open
 * read-only with an honest notice and no Edit button."
 *
 * Kept dependency-free and side-effect-free so it is directly unit-testable
 * (no React, no filesystem) and so PreviewScreen's ⋯ menu / read-only notice
 * can share ONE source of truth for "can this file be edited right now".
 */

import { formatBytes } from './format';

/** Editable text files must be at or under this size. */
export const MAX_EDITABLE_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB

export interface TextEditGateInput {
  /** Server-reported plaintext size, when known. */
  sizeBytes: number | null | undefined;
  /** The decoded text content, once loaded (null while still loading). */
  decodedText: string | null;
  /** True when decoding/decrypting the file as text already failed. */
  decodeFailed: boolean;
}

export interface TextEditGateResult {
  editable: boolean;
  /** Human-readable reason shown next to a disabled Edit control; null while
   *  still loading or when the file IS editable. */
  reason: string | null;
}

/**
 * The Unicode replacement character (`U+FFFD`) is what a lossy UTF-8 decode
 * substitutes for a byte sequence that isn't valid UTF-8. `expo-file-system`
 * always decodes `isText` files as UTF-8 (PreviewScreen's read-view effect),
 * so a stray U+FFFD in content that otherwise "loaded fine" is the signal
 * that the underlying bytes were never real UTF-8 to begin with — the read
 * view can still show best-effort content, but editing (which would
 * re-encode and overwrite the ORIGINAL bytes with a lossy round-trip) must
 * be refused.
 */
function looksLikeLossyUtf8(text: string): boolean {
  return text.includes('�');
}

export function evaluateTextEditGate(input: TextEditGateInput): TextEditGateResult {
  if (input.decodeFailed) {
    return { editable: false, reason: "This file couldn't be read as text." };
  }
  if (input.decodedText == null) {
    // Still loading — no verdict yet, but also nothing to disable-with-reason.
    return { editable: false, reason: null };
  }
  if (looksLikeLossyUtf8(input.decodedText)) {
    return { editable: false, reason: "This file isn't valid UTF-8 text, so it opens read-only." };
  }
  const size = input.sizeBytes ?? null;
  if (size == null || size > MAX_EDITABLE_TEXT_BYTES) {
    return {
      editable: false,
      reason: `Files over ${formatBytes(MAX_EDITABLE_TEXT_BYTES)} open read-only.`,
    };
  }
  return { editable: true, reason: null };
}
