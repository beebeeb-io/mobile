import { uploadPhotoPreviewNative } from '../../modules/beebeeb-crypto';
import { getApiUrl, getToken, serverSupportsPhotoPreviews } from './api';
import {
  dropCachedPreview,
  fetchPreviewToCache,
  getCachedPreview,
  getPreviewCacheLimitBytes,
  trimPreviewCache,
} from './photo-preview-cache';
import type { PhotoPreviewSetting } from './photo-preview-settings';
import { getSessionPhotoPreviewSetting } from './photo-preview-sync';
import { getExpectedUserId } from './expected-user';
import { sharedMasterHandleId } from './shared-folder-keys';

/** The few fields of a drive file the viewer decisions need (a `FileEntry` fits). */
export interface ViewerFile {
  id: string;
  mime_type?: string | null;
  has_preview?: boolean;
  /** The stored preview's format and long edge, when the row knows them. */
  preview_format?: string | null;
  preview_px?: number | null;
  /** The stored preview's size on the server; changes whenever the preview is re-made. */
  preview_bytes?: number | null;
}

/**
 * The row says this file has no stored preview (cleared by a new version, Off, or a
 * delete elsewhere): a cached copy is out of date and must never be shown again.
 */
export function forgetStoredPreviewIfGone(file: ViewerFile): void {
  if (file.has_preview === false) void dropCachedPreview(file.id).catch(() => {});
}

/**
 * True when the zoom magnifies the preview past 1:1 (one preview pixel larger than
 * one device pixel), so the original would show more detail. The "Original"
 * control is highlighted then. With the preview's pixel size the fitted
 * ("contain") scale is exact for any aspect ratio; without it, the page width is
 * compared with the preview's long edge (exact for landscape, late for portrait).
 */
export function zoomExceedsPreview(
  scale: number,
  view: { width: number; height: number },
  pixelRatio: number,
  image: { width: number; height: number } | null,
  previewPx?: number | null,
): boolean {
  if (!(scale > 1) || !(pixelRatio > 0) || !(view.width > 0)) return false;
  if (image && image.width > 0 && image.height > 0 && view.height > 0) {
    const fit = Math.min(view.width / image.width, view.height / image.height);
    return scale * fit * pixelRatio > 1;
  }
  if (!previewPx || previewPx <= 0) return false;
  return scale * view.width * pixelRatio > previewPx;
}

export type ImageSource = 'cache' | 'download-preview' | 'existing';

/**
 * Where the viewer gets its picture: the local preview cache, a download of the
 * stored preview, or today's behaviour (thumbnail, then original). A server that
 * cannot store previews, or a file without one, always keeps today's behaviour.
 */
export function chooseImageSource(
  file: ViewerFile,
  cached: string | null,
  serverSupported: boolean,
  offlinePinned = false,
): ImageSource {
  if (!serverSupported || file.has_preview !== true) return 'existing';
  if (cached) return 'cache';
  // A file kept available offline uses on-device data only: never fetch its preview.
  return offlinePinned ? 'existing' : 'download-preview';
}

export interface ViewerImage {
  uri: string;
  kind: 'preview' | 'original';
  source: ImageSource;
}

/**
 * The stored preview for a file (cache, then download), or null when today's
 * behaviour should run. Never throws: any failure means "use the existing path".
 */
export async function loadStoredPreview(
  file: ViewerFile,
  opts: { offlinePinned?: boolean } = {},
): Promise<{ uri: string; source: 'cache' | 'download-preview' } | null> {
  try {
    if (file.has_preview !== true) {
      forgetStoredPreviewIfGone(file);
      return null;
    }
    const supported = await serverSupportsPhotoPreviews();
    if (!supported) return null;
    const expected = { format: file.preview_format ?? null, px: file.preview_px ?? null, bytes: file.preview_bytes ?? null };
    const cached = await getCachedPreview(file.id, expected);
    const source = chooseImageSource(file, cached, supported, opts.offlinePinned === true);
    if (source === 'cache' && cached) return { uri: cached, source };
    if (source === 'download-preview') {
      const uri = await fetchPreviewToCache(file.id, expected);
      if (!uri) return null;
      // The preview on screen is never trimmed away.
      void getPreviewCacheLimitBytes()
        .then((limit) => trimPreviewCache(limit, new Set([file.id])))
        .catch(() => {});
      return { uri, source };
    }
  } catch {
    // fall through to the existing path
  }
  return null;
}

/**
 * Preview first, then `existing` (the thumbnail/original path the screen already
 * has). Without an `existing` loader a file with no usable preview rejects.
 */
export async function loadViewerImage(
  file: ViewerFile,
  existing?: () => Promise<{ uri: string }>,
  opts: { offlinePinned?: boolean } = {},
): Promise<ViewerImage> {
  const stored = await loadStoredPreview(file, opts);
  if (stored) return { uri: stored.uri, kind: 'preview', source: stored.source };
  if (!existing) throw new Error('No stored preview for this file');
  const loaded = await existing();
  return { uri: loaded.uri, kind: 'original', source: 'existing' };
}

/** Opened original -> make a preview: images only, setting on, server able, none stored yet. */
export function shouldGenerateFromOpenedOriginal(
  file: ViewerFile,
  setting: PhotoPreviewSetting,
  serverSupported: boolean,
): boolean {
  return (
    serverSupported &&
    setting.enabled &&
    file.has_preview === false &&
    typeof file.mime_type === 'string' &&
    file.mime_type.startsWith('image/')
  );
}

const attempted = new Set<string>();

export function __resetPhotoPreviewViewerForTests(): void {
  attempted.clear();
}

function toPath(uri: string): string {
  const stripped = uri.replace(/^file:\/\//, '');
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

export type OpenedOriginalUpload = (localUri: string, release?: () => void | Promise<void>) => Promise<void>;

/**
 * Phase 1 of making a preview from an opened original: everything that needs
 * the network or storage (server support, setting, token) is resolved BEFORE the
 * decrypted file exists, so nothing is awaited between "file ready" and the
 * native call. Resolves to null when no preview should be made, else a runner.
 * The runner owns `release`: it calls it once the native upload has settled
 * (success or failure), so the caller can keep the plaintext alive until then.
 * A failed upload is forgotten so a later open can retry.
 */
export async function prepareGenerateFromOpenedOriginal(file: ViewerFile): Promise<OpenedOriginalUpload | null> {
  try {
    if (attempted.has(file.id)) return null;
    if (file.has_preview !== false || !file.mime_type?.startsWith('image/')) return null;
    const [supported, setting] = await Promise.all([serverSupportsPhotoPreviews(), getSessionPhotoPreviewSetting()]);
    if (!shouldGenerateFromOpenedOriginal(file, setting, supported)) return null;
    const token = await getToken();
    if (!token) return null;
    const handleId = sharedMasterHandleId();
    const apiUrl = getApiUrl();
    return async (localUri, release) => {
      if (attempted.has(file.id)) {
        await release?.();
        return;
      }
      attempted.add(file.id);
      try {
        await uploadPhotoPreviewNative(
          handleId, apiUrl, token, file.id, null, toPath(localUri), setting.format, setting.px, getExpectedUserId(),
        );
        // A new stored preview of (possibly new) content: an older cached copy is stale.
        await dropCachedPreview(file.id).catch(() => {});
      } catch {
        attempted.delete(file.id);
      } finally {
        try { await release?.(); } catch { /* best effort */ }
      }
    };
  } catch {
    return null;
  }
}
