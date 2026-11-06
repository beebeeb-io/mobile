/**
 * Task 2335 — which videos the in-app player can open, per platform, and what
 * the preview says when it can't.
 *
 * A 17.48 GB `.mkv` pushed with the CLI was handed to AVPlayer (expo-video on
 * iOS), which has no Matroska demuxer; the preview showed a player that never
 * started. iOS now keeps such a file away from the player and names the
 * format instead, with Save to Files. Android's ExoPlayer plays these
 * containers, so Android is unchanged.
 *
 * ONE place for the rule. The core transfer design (workspace PR #554, phase 1)
 * moves it into core's playability table, splitting `PreviewPlatform::Mobile`
 * into iOS and Android; that table replaces this module.
 *
 * Open spec-vs-code contradiction until then: core's `media.rs` says MKV plays on
 * `Mobile`; this gate says it does not on iOS. The recorded resolution is plan task
 * 1.1 of workspace PR #554 ("core, playability per player": the `Ios` column is the
 * `Mobile` column minus mkv, webm and wmv, the three listed here).
 *
 * The refused list is measured, not assumed: AVFoundation on macOS 26.6.2 (the
 * task 2335 research lane, `mimes.out` and `avprobe.out`) refused 3 of the 13
 * `STREAMABLE_VIDEO_EXTENSIONS` — mkv (video/x-matroska), webm (video/webm),
 * wmv (video/x-ms-wmv) — and accepted the other 10. An MKV holding the same
 * HEVC + AAC streams as a playable MP4 failed "Cannot Open"
 * (AVFoundationErrorDomain -11828). macOS, not an iOS device: the same
 * framework, and the player-error state (`videoPlayerErrorMessage`) still
 * catches any container iOS refuses that macOS accepted.
 */

const FORMAT_LABEL_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  mkv: 'MKV',
  webm: 'WebM',
  wmv: 'WMV',
});

export const IOS_UNPLAYABLE_VIDEO_EXTENSIONS: ReadonlySet<string> = Object.freeze(new Set(Object.keys(FORMAT_LABEL_BY_EXTENSION)));

/** MIME type → the container's name as people know it. */
const IOS_UNPLAYABLE_VIDEO_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'video/x-matroska': 'MKV',
  // RFC 9559 registered the same container under this name.
  'video/matroska': 'MKV',
  'video/webm': 'WebM',
  'video/x-ms-wmv': 'WMV',
});

export type InAppVideoPlayability = { playable: true } | { playable: false; formatLabel: string };

const PLAYABLE: InAppVideoPlayability = Object.freeze({ playable: true });

function bareMimeType(mimeType: string | null | undefined): string {
  return (mimeType ?? '').split(';')[0].trim().toLowerCase();
}

function fileExtension(fileName: string | null | undefined): string {
  const name = (fileName ?? '').trim();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Can the in-app player open this video on `platform` (`Platform.OS`)?
 * Either signal is enough to refuse: the MIME type (from the name envelope)
 * or the file name's extension. Neither is a guess at the codecs inside.
 */
export function inAppVideoPlayability(
  platform: string,
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): InAppVideoPlayability {
  if (platform !== 'ios') return PLAYABLE;
  const byMime = IOS_UNPLAYABLE_VIDEO_MIME_TYPES[bareMimeType(mimeType)];
  if (byMime) return { playable: false, formatLabel: byMime };
  const extension = fileExtension(fileName);
  if (IOS_UNPLAYABLE_VIDEO_EXTENSIONS.has(extension)) {
    return { playable: false, formatLabel: FORMAT_LABEL_BY_EXTENSION[extension] };
  }
  return PLAYABLE;
}

/** The unsupported-format state's line under the file name. */
export function unplayableVideoMessage(deviceNoun: string): string {
  return `This format can't play on ${deviceNoun}.`;
}

/** What the Save to Files action under it is for. */
export function unplayableVideoActionHint(formatLabel: string): string {
  return `Save it to Files to open it in an app that plays ${formatLabel}.`;
}

/** expo-video 57 (iOS, `VideoExceptions.swift`) wraps AVFoundation's reason in these. */
const PLAYER_ERROR_WRAPPERS = [/^Failed to load the player item:\s*/i, /^Failed to initialise the player:\s*/i];

/** What a failed play says: that the player stopped, and AVFoundation's reason when it gave one. */
export function videoPlayerErrorMessage(error: { message?: string | null } | null | undefined): string {
  let reason = (error?.message ?? '').trim();
  for (const wrapper of PLAYER_ERROR_WRAPPERS) reason = reason.replace(wrapper, '').trim();
  return reason ? `The video player couldn't open this file (${reason}).` : "The video player couldn't open this file.";
}
