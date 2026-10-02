/**
 * preview-load-error — what the preview says when a file cannot be loaded
 * (task 1592 item 3).
 *
 * Opening a file whose row is still marked as uploading made the server
 * answer the download with 409 ("upload is still in progress"). The native
 * download path turns that into an Expo exception, and the preview printed
 * it raw: "UnexpectedException: Download failed with HTTP 409 (at
 * ExpoModulesCore/ConcurrentFunctionDefinition.swift:90)". That is neither
 * honest about what is going on nor something a person can act on.
 */
import { ApiError, friendlyError } from './api';

export const STILL_UPLOADING_MESSAGE = 'This file is still uploading. Try again in a moment.';

/**
 * Task 1687d — what a genuinely PARTIAL result says. A decrypt that produced
 * fewer plaintext bytes than the file's metadata (a truncated cache entry
 * from a mid-write crash, or a native decrypt that came up short) used to
 * render the decodable prefix silently — a "halve file" with no
 * explanation. The message is plain about what happened and what to do;
 * no promises that a retry "should work".
 */
export const PARTIAL_DECRYPT_MESSAGE = "This file didn't fully decrypt. The local copy is incomplete — try again to fetch it fresh.";

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return '';
}

/**
 * True when a preview download failed because the file is still marked as
 * uploading: the server's 409 on `GET /files/:id/download` (JS path, an
 * `ApiError`) or the same status surfaced by the native downloader
 * ("Download failed with HTTP 409").
 */
export function isStillUploadingError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 409 && /in progress|uploading/i.test(err.message ?? '');
  }
  return /\bHTTP 409\b/.test(messageOf(err));
}

/**
 * Strips the native bridge's wrapping from an error message:
 * "UnexpectedException: <message> (at Some/File.swift:90)" → "<message>".
 */
export function stripNativeExceptionNoise(message: string): string {
  return message
    .replace(/^\s*[A-Za-z]+Exception:\s*/, '')
    .replace(/\s*\(at [^()]*\.(?:swift|m|mm|kt|java):\d+\)\s*$/, '')
    .trim();
}

/** The message the preview shows for a failed load. */
export function previewLoadErrorMessage(err: unknown): string {
  if (isStillUploadingError(err)) return STILL_UPLOADING_MESSAGE;
  // Task 1687d — a plain Error's honest message (e.g. PARTIAL_DECRYPT_
  // MESSAGE, thrown by native-decrypt's size check) passes through
  // verbatim: friendlyError returns a plain Error's own message, and the
  // native-bridge stripper only removes "…Exception:" prefixes and
  // "(at File.swift:N)" suffixes, neither of which the partial message
  // carries. The partial-decrypt tests pin that pass-through; a special-
  // case map here would be dead code (kept out deliberately).
  const friendly = friendlyError(err);
  return stripNativeExceptionNoise(friendly) || 'Something went wrong. Please try again.';
}
