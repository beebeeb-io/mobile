/**
 * preview-temp-file — pure helper for "delete the decrypted temp file when
 * the preview closes" (task 1568, audio player).
 *
 * PreviewScreen.tsx's video/PDF/audio branches all decrypt to a real file on
 * disk (never held only in memory) and are supposed to delete it once the
 * screen unmounts — video's own effect does this inline
 * (`tempVideoUriRef` + a bare `FileSystem.deleteAsync(...).catch(() => {})`
 * in a cleanup function). That inline shape cannot be unit-tested: this
 * project's test runner (bun test) has no React reconciler, so PreviewScreen
 * itself is never imported directly in a test (see
 * PreviewScreen.webview-parent.test.ts's own doc comment — it asserts against
 * the SOURCE TEXT for exactly this reason).
 *
 * Audio's cleanup instead calls this extracted, dependency-injected function
 * so the actual deletion behaviour — not just a source-text shape — has a
 * real, mutation-provable test (`preview-temp-file.test.ts`).
 */

/** Shape of `expo-file-system`'s `deleteAsync` — injected rather than
 * imported directly so tests don't need to mock the native module. */
export type DeleteAsyncFn = (
  uri: string,
  options: { idempotent: boolean },
) => Promise<void>;

/** A React ref-shaped box holding the currently-tracked temp file's uri (or
 * null if nothing is tracked). Matches `useRef<string | null>(null)`'s
 * `.current` field exactly, so a real `tempAudioUriRef` can be passed in
 * unchanged. */
export interface TempFileRef {
  current: string | null;
}

/**
 * Deletes the temp file tracked in `ref.current` (idempotent — a already-
 * gone file is not an error) and clears the ref. No-ops (never calls
 * `deleteAsync`) when nothing is tracked. The ref is cleared synchronously,
 * before the delete resolves — matches video's own inline pattern, which
 * clears its ref without awaiting the delete either, so a rapid unmount →
 * remount cycle never sees a stale uri.
 *
 * Delete failures are swallowed (same as video's `.catch(() => {})`): a
 * best-effort cleanup on unmount should never throw into React's teardown
 * path, and there is nothing further downstream that could act on the
 * failure.
 */
export function cleanupTrackedTempFile(
  ref: TempFileRef,
  deleteAsync: DeleteAsyncFn,
): Promise<void> {
  const uri = ref.current;
  if (!uri) return Promise.resolve();
  ref.current = null;
  return deleteAsync(uri, { idempotent: true }).catch(() => {});
}
