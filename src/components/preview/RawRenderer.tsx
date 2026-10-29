/**
 * RawRenderer — full-bleed photo view for camera RAW previews (task 1569:
 * CR2/CR3/ARW/NEF/RAF/DNG had no preview handling in mobile at all).
 *
 * Renders inside the MEDIA branch (`isMediaPreview` now includes
 * `isRaw` — see PreviewScreen.tsx), on the same forced-dark full-bleed
 * stage as photos/video (`design/preview-redesign-ios.html`'s own
 * `.photo{background:#000}`, already extended to RAW by an earlier
 * comment: "images/RAW on black"). All text here is therefore a fixed
 * white/amber literal, not a theme token — the same forced-ground
 * argument the image/video error states in PreviewScreen.tsx already use.
 *
 * Imported EAGERLY (not `React.lazy`) and rendered directly (no
 * `Suspense`) from PreviewScreen.tsx. This was changed mid-investigation
 * while chasing a blank-screen bug that turned out to have a DIFFERENT root
 * cause entirely (a bad JPEG span in `raw-preview.ts` — see this file's
 * `DEVIATIONS.md` entry for the full, corrected account: two earlier
 * theories, including one that pointed at Suspense/mediaStage, did NOT
 * survive re-testing). Left as an eager import anyway, not reverted: every
 * OTHER lazy renderer in this app is used from the DOC branch — isImage/
 * isVideo, the only two pre-existing MEDIA branch categories, never use
 * React.lazy/Suspense at all — so this matches the media branch's own
 * existing precedent rather than introducing a new pattern there, even
 * though it wasn't the fix for the bug that prompted the change.
 *
 * The actual extraction (find the largest embedded JPEG, best-effort EXIF)
 * lives in `../../lib/raw-extract.ts` (impure glue) built on
 * `../../lib/raw-preview.ts` (pure scan/parse core) — see that module's own
 * doc comment for why a byte-scan beats calling `exifr.thumbnail()`
 * directly, and why EXIF uses a hand-rolled TIFF reader instead of `exifr`
 * (Hermes Release-build incompatibility). This component is deliberately
 * thin: loading state, the extracted image, the "embedded preview" caption,
 * and an honest fallback card when extraction finds nothing (corrupt file,
 * or a RAW with no embedded JPEG at all) — matches the audio/video/PDF
 * branches' own error-card shape (title + one-line explanation), not a
 * blank screen or a spinner that never ends.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, fonts } from '../../theme';
import { extractRawPreview, type RawExifInfo } from '../../lib/raw-extract';
import { cleanupTrackedTempFile, type TempFileRef } from '../../lib/preview-temp-file';

interface RawRendererProps {
  /** On-disk decrypted RAW file (deleted by the CALLER on unmount — see
   * PreviewScreen.tsx's raw cleanup effect, same pattern as audio/video). */
  uri: string;
  fileName: string;
  /** "Canon RAW" / "Sony RAW" / … — from `rawFormatLabel`, shown in the
   * fallback card when no embedded preview could be extracted. */
  formatLabel: string;
  /** Stable per-file key for this renderer's OWN extracted-preview cache
   * file (distinct from `uri`, which is the source RAW) — the current
   * file id is what callers pass, matching `fetchAndDecrypt`'s own
   * `${currentFileId}_${cacheFileName}` cache-naming convention. */
  cacheKey: string;
  /** Bubbles the parsed EXIF summary up to PreviewScreen's Info sheet —
   * called with `null` when extraction fails or found no EXIF, so the
   * caller can omit the section entirely rather than show blank rows. */
  onExifInfo?: (info: RawExifInfo | null) => void;
}

type RawRenderStatus = 'loading' | 'ready' | 'failed';

export function RawRenderer({ uri, fileName, formatLabel, cacheKey, onExifInfo }: RawRendererProps) {
  const [status, setStatus] = useState<RawRenderStatus>('loading');
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const tempPreviewUriRef = useRef<string | null>(null) as TempFileRef;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setPreviewUri(null);
    setImageFailed(false);

    (async () => {
      try {
        const cacheDir = FileSystem.cacheDirectory ?? '';
        const result = await extractRawPreview(uri, cacheDir, cacheKey);
        if (cancelled) {
          // Screen already moved on (e.g. swiped away) by the time
          // extraction finished — clean up the file this call wrote
          // directly, since the ref below never gets a chance to see it.
          if (result.previewUri) {
            FileSystem.deleteAsync(result.previewUri, { idempotent: true }).catch(() => {});
          }
          return;
        }
        onExifInfo?.(result.exif);
        if (result.previewUri) {
          tempPreviewUriRef.current = result.previewUri;
          setPreviewUri(result.previewUri);
          setStatus('ready');
        } else {
          setStatus('failed');
        }
      } catch {
        if (!cancelled) {
          onExifInfo?.(null);
          setStatus('failed');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, cacheKey]);

  // Delete THIS renderer's own extracted-preview temp file whenever the
  // source changes or the renderer unmounts. Separate from the source RAW
  // temp file's own cleanup (PreviewScreen.tsx owns that one, same as
  // video/audio) — this component created this second file, so it owns
  // cleaning it up.
  useEffect(() => {
    return () => {
      void cleanupTrackedTempFile(tempPreviewUriRef, FileSystem.deleteAsync);
    };
  }, [uri]);

  if (status === 'loading') {
    return (
      <View style={styles.center} testID="raw-loading">
        <ActivityIndicator color={colors.amber} />
        <Text style={styles.loadingText}>Extracting preview…</Text>
      </View>
    );
  }

  if (status === 'failed' || !previewUri || imageFailed) {
    return (
      <View style={styles.center} testID="raw-fallback">
        <Text style={styles.fallbackTitle}>Couldn't preview this RAW file</Text>
        <Text style={styles.fallbackSub}>
          {formatLabel} — no embedded preview could be extracted. Download to open the original.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.fill} testID="raw-image-wrap">
      <Image
        source={{ uri: previewUri }}
        style={styles.fill}
        resizeMode="contain"
        accessibilityLabel={fileName}
        testID="raw-image"
        onError={() => setImageFailed(true)}
      />
      <View style={styles.captionWrap} pointerEvents="none">
        <Text style={styles.captionText} testID="raw-caption">
          Embedded preview · download for full quality
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Task 1569: percentage width/height (matching the sibling isImage
  // branch's `mediaImage` style) rather than `flex: 1`. Changed while
  // investigating a blank-screen bug that turned out to have a DIFFERENT
  // root cause (see this file's top doc comment and DEVIATIONS.md) — this
  // change alone did NOT fix that bug, `flex: 1` was re-tested and works
  // fine in this exact slot. Kept anyway as the established, lower-risk
  // pattern the rest of the media branch already uses, not because it's
  // load-bearing here.
  fill: { width: '100%', height: '100%' },
  center: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 32,
  },
  loadingText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    marginTop: 4,
  },
  fallbackTitle: {
    color: colors.white,
    fontSize: 17,
    fontWeight: '600',
    textAlign: 'center',
  },
  fallbackSub: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  captionWrap: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  captionText: {
    color: colors.white,
    fontSize: 11,
    fontFamily: fonts.mono,
  },
});

export default RawRenderer;
