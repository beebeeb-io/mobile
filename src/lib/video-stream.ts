/**
 * Task 1683j — pure contracts for chunked streaming video playback
 * (decrypt-as-the-player-reads). Kept free of React/Native imports so the
 * bun test suite (and any future desktop twin) can exercise the routing +
 * progress-mapping rules directly.
 *
 * The native engine (`VideoStreamer`, Kotlin) fetches the vault's per-chunk
 * AEAD frames, decrypts ahead of the playhead into a sparse plaintext temp
 * file, and serves it to ExoPlayer over a loopback-only HTTP server with
 * proper 206/Range semantics. JS routes video previews to it and renders the
 * buffered percent while the pump keeps filling in the background.
 */
import { formatBytes } from './format';

/**
 * The plaintext extensions that route to `streamVideoNative`. The server
 * stores videos under the mobile chunk ladder and every phone-recorded
 * container ExoPlayer decodes progressively; `extensionForMime` yields these
 * lowercase for video/*, and `previewDecryptExtension`'s filename fallback
 * may keep the original case — so the check is case-insensitive.
 *
 * Everything else (PDFs, images, audio, docs, …) keeps the whole-file
 * download+decrypt path: their preview needs the COMPLETE file anyway (a
 * first page/thumbnail is not a stream), so streaming buys them nothing.
 */
export const STREAMABLE_VIDEO_EXTENSIONS: ReadonlySet<string> = Object.freeze(
  new Set([
    'mp4',
    'm4v',
    'mov',
    'webm',
    'mkv',
    '3gp',
    '3g2',
    'avi',
    'mpg',
    'mpeg',
    'ts',
    'm2ts',
    'wmv',
  ]),
);

/** True when `ext` routes to the streaming engine (case-insensitive). */
export function isStreamableVideoExtension(ext: string | null | undefined): boolean {
  if (!ext) return false;
  return STREAMABLE_VIDEO_EXTENSIONS.has(ext.replace(/^\./, '').toLowerCase());
}

/**
 * The loopback prefix the native engine hands out
 * (`http://127.0.0.1:<port>/s/<streamId>/v.<ext>`; `localhost` is the same
 * interface). A returned preview URI matching this means the video is being
 * SERVED by the streaming session — the player reads it, and cleanup must
 * not `deleteAsync` it (the plaintext lives at the preview-cache path, lease-
 * managed like every other preview copy).
 */
export const LOOPBACK_STREAM_PREFIXES = ['http://127.0.0.1', 'http://localhost'];

/** True when `uri` is a loopback stream URI handed out by the engine. */
export function isLoopbackStreamUri(uri: string | null | undefined): boolean {
  if (!uri) return false;
  return LOOPBACK_STREAM_PREFIXES.some((prefix) => uri.startsWith(prefix));
}

/**
 * Map a native preview-load progress event to the buffered percent the UI's
 * "Streaming · N% buffered" badge shows:
 *  - `number`   — a streaming decrypt event with a nonzero total: the badge
 *                 updates;
 *  - `null`     — a terminal stage (complete/error): the badge hides;
 *  - `undefined`— nothing to change (non-streaming events, download ticks):
 *                 the caller keeps its current value.
 *
 * The whole-file path's decrypt events carry NO `streaming` flag, so they
 * never drive the badge — the badge only reflects a live streaming session.
 */
export function streamBufferPctFromEvent(
  event: {
    stage: string;
    streaming?: boolean;
    chunksCompleted?: number;
    chunksTotal?: number;
  } | null | undefined,
): number | null | undefined {
  if (!event) return undefined;
  if (event.stage === 'complete' || event.stage === 'error') return null;
  if (event.stage !== 'decrypting' || event.streaming !== true) return undefined;
  const total = event.chunksTotal ?? 0;
  if (total <= 0) return undefined;
  const completed = event.chunksCompleted ?? 0;
  return Math.min(100, Math.round((completed * 100) / total));
}

/**
 * Task 2335 — the progress row while a stream starts. Before the player gets
 * a URL the native engine fetches chunk 0 and the tail chunk whole (every
 * reader holds a whole chunk; with the CLI's 128 MiB chunks that is about
 * 166 MB). Its `downloading` events then carry `buffering: true`, and
 * `bytesTotal` is the bytes it needs before playback, not the whole file.
 *
 * Null for anything else: the whole-file path keeps its own
 * "Downloading X of Y" (its events carry no buffering flag).
 */
export function startupBufferingText(
  progress: {
    stage: string | null;
    buffering?: boolean;
    bytesDownloaded?: number;
    bytesTotal?: number;
  } | null | undefined,
): string | null {
  if (!progress || progress.stage !== 'downloading' || progress.buffering !== true) return null;
  const needed = progress.bytesTotal ?? 0;
  if (needed <= 0) return null;
  const done = Math.min(needed, Math.max(0, progress.bytesDownloaded ?? 0));
  return `Buffering ${formatBytes(done)} of ${formatBytes(needed)}`;
}
