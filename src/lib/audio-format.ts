/**
 * audio-format — pure helpers for the audio preview player (task 1568):
 * resolving a decrypted file's REAL container extension, and formatting
 * elapsed/remaining playback time for the scrub bar.
 *
 * `PreviewScreen.tsx` decrypts every previewed file to a temp file whose
 * NAME carries the extension AVFoundation/expo-audio use (alongside content
 * sniffing) to pick a decoder — writing a WAV file to disk as "*.mp3" is
 * fragile. Before this task, `extensionForMime` collapsed EVERY audio
 * mime/category to a hardcoded `.mp3` regardless of actual codec (a latent
 * bug found while building the player, not introduced by it — see git blame
 * on the pre-1568 `if (mime.startsWith('audio/')) return '.mp3';` line).
 *
 * Extracted as its own pure, dependency-free module (same pattern as
 * `preview-content-inset.ts` / `preview-chrome.ts` / `text-edit-gate.ts` —
 * see their own doc comments) specifically so this logic is unit-testable:
 * `PreviewScreen.tsx` itself cannot be imported in this project's test
 * runner (bun test has no React reconciler — see
 * `PreviewScreen.webview-parent.test.ts`'s doc comment for why that file
 * asserts against source text instead), and `AudioRenderer.tsx` renders a
 * live `expo-audio` player that isn't unit-testable for the same reason.
 */

/** Mime → extension for the audio containers this app resolves explicitly.
 * What the OS/browser reports at upload — reliable for this small, known
 * set (unlike, say, arbitrary source-code file mimes — see task 1565
 * finding 3), so mime is checked BEFORE falling back to the filename. */
const AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/aacp': '.aac',
  'audio/x-aac': '.aac',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/ogg': '.ogg',
};

const AUDIO_EXTENSION_RE = /\.(mp3|m4a|aac|wav|flac|ogg)$/;

/**
 * Resolves the extension (leading dot included, e.g. `.wav`) for an audio
 * file: mime-based mapping first, then the ORIGINAL filename's own
 * extension when the mime is missing/unrecognized, then `.mp3` as the last
 * resort (matches the pre-1568 default for truly undetectable audio, so
 * this is a strict narrowing of the old behaviour, not a behaviour change
 * for the unknown case).
 */
export function extensionForAudio(mimeType: string | null | undefined, fileName?: string | null): string {
  const mime = (mimeType ?? '').toLowerCase();
  const fromMime = AUDIO_EXTENSION_BY_MIME[mime];
  if (fromMime) return fromMime;
  const fromName = (fileName ?? '').toLowerCase().match(AUDIO_EXTENSION_RE)?.[1];
  if (fromName) return `.${fromName}`;
  return '.mp3';
}

/**
 * Formats a duration in seconds as `M:SS` (or `H:MM:SS` past one hour) for
 * the scrub bar's elapsed/duration labels. Non-finite or negative input
 * (audio not loaded yet, `NaN` from a not-yet-known duration) renders as
 * `0:00` rather than `NaN:NaN` or a negative time.
 */
export function formatAudioTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const total = Math.floor(totalSeconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const secStr = seconds.toString().padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secStr}`;
  }
  return `${minutes}:${secStr}`;
}

/**
 * Formats the TIME REMAINING (duration - currentTime, floored at zero so a
 * currentTime that has drifted past duration by a frame never shows a
 * negative countdown) with a leading "-", matching the standard mobile
 * audio-player convention (Apple Music, Podcasts, …).
 */
export function formatAudioRemaining(currentTime: number, duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return '-0:00';
  const remaining = Math.max(0, duration - currentTime);
  return `-${formatAudioTime(remaining)}`;
}

/**
 * True when a track has played to its end and needs an explicit seek-to-0
 * before Play will audibly restart it (task 1568, Codex P2 follow-up on PR
 * #125's review: once `expo-audio` reaches the end, `playing` goes false but
 * `currentTime` stays PARKED at `duration` — calling `player.play()` from
 * that position does nothing, since the native player was never rewound).
 *
 * ORs two signals rather than trusting either alone:
 * - `didJustFinish` is EDGE-triggered — `expo-audio`'s own status only
 *   reports it `true` for the single status tick right at completion, so a
 *   user who waits a few seconds before pressing Play again would see it
 *   already back to `false` even though the track is still sitting at the
 *   end.
 * - `currentTime >= duration` is LEVEL-triggered — true for as long as the
 *   player sits at the end, independent of timing — but needs `duration > 0`
 *   guarded explicitly: before the player has loaded, both are `0`, and
 *   `0 >= 0` would otherwise misreport an unloaded track as "finished".
 */
export function isTrackFinished(didJustFinish: boolean, currentTime: number, duration: number): boolean {
  return didJustFinish || (duration > 0 && currentTime >= duration);
}
