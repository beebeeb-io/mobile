import type { PhotoPreviewSummary } from './api';
import { formatBytes } from './format';

/**
 * The "what will happen" confirmations of the photo previews screen, and the
 * storage line of the Storage screen. Pure, so the copy is tested as written.
 */

export interface ApplyConfirmInput {
  /** "720p" | "1080p" | "2K" | "4K" */
  sizeLabel: string;
  format: 'heic' | 'jpeg';
  /** Estimated Beebeeb storage the new previews use; null when unknown. */
  storageBytes: number | null;
  /** False on cellular (or unknown network): the mobile-data clause is shown. */
  onWifi: boolean;
  /** Photos skipped because their original is not on this iPhone. */
  skipped: number;
}

function introLines(input: ApplyConfirmInput): string[] {
  return [
    `• Each photo gets a new ${input.sizeLabel} ${input.format.toUpperCase()} preview, made from the original on this iPhone.`,
    '• Your current previews stay until each new one is ready.',
    '• Your original photos are not touched.',
    '• Keep Beebeeb open until it finishes. If you close it, it continues where it left off next time.',
  ];
}

function applyLines(input: ApplyConfirmInput): string[] {
  const lines = introLines(input);
  const data = !input.onWifi ? 'uses mobile data unless you are on Wi-Fi' : null;
  if (input.storageBytes != null && input.storageBytes > 0) {
    lines.push(`• Uses about ${formatBytes(input.storageBytes)} of your Beebeeb storage${data ? `; ${data}` : ''}.`);
  } else if (data) {
    lines.push(`• It ${data}.`);
  }
  return lines;
}

function skippedSentence(skipped: number): string | null {
  return skipped > 0
    ? `${skipped.toLocaleString()} photos that are not on this iPhone are skipped; they get a preview the first time you open them here.`
    : null;
}

export function applyConfirmMessage(input: ApplyConfirmInput): string {
  const skipped = skippedSentence(input.skipped);
  return [...applyLines(input), ...(skipped ? ['', skipped] : [])].join('\n');
}

export function rebuildConfirmMessage(input: ApplyConfirmInput): string {
  const skipped = skippedSentence(input.skipped);
  // Each new preview replaces one at the same setting: storage use stays about the same.
  const replaces = input.storageBytes != null && input.storageBytes > 0
    ? [`• Replaces about ${formatBytes(input.storageBytes)} of previews. Your Beebeeb storage use stays about the same.`]
    : [];
  return [
    ...introLines(input),
    ...replaces,
    '• Rebuilding takes a while and uses battery. It uses mobile data unless you are on Wi-Fi.',
    ...(skipped ? ['', skipped] : []),
  ].join('\n');
}

/** `freedBytes` from the server summary; null leaves the amount out. */
export function turnOffConfirmMessage(freedBytes: number | null): string {
  const about = freedBytes != null && freedBytes > 0 ? `, about ${formatBytes(freedBytes)}` : '';
  return [
    `• Deletes all previews from your Beebeeb storage and this iPhone${about}. You can't undo this, but you can make them again later.`,
    '• Your original photos are not touched.',
  ].join('\n');
}

/** "Photo previews: X" for the Storage screen; null when there are none or no support. */
export function photoPreviewStorageLine(summary: PhotoPreviewSummary | null): string | null {
  if (!summary || !(summary.count > 0)) return null;
  return `Photo previews: ${formatBytes(Math.max(0, summary.total_bytes))}`;
}

/**
 * A run stopped because the account's Beebeeb storage is full (the server refused
 * the preview PUT with 413 `quota_exceeded`). One sentence for the whole run: every
 * remaining photo would be refused the same way, and the fix is storage, not a
 * smaller size. Same tone and wording as the upload refusal in `friendlyError`.
 */
export function previewQuotaExceededMessage(done: number): string {
  const made = done > 0 ? `${done.toLocaleString()} previews made; the rest could not be made. ` : '';
  return `${made}This account has reached its storage limit. Free up space to make the remaining previews.`;
}
