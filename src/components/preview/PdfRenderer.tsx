/**
 * PdfRenderer — multi-page PDF viewer with vertical scroll.
 *
 * Uses react-native-pdf for native rendering with pinch-to-zoom.
 *
 * Preview redesign (task 1563 follow-up, design item 6): the page counter
 * used to be this component's OWN floating pill (bottom-center, auto-fading
 * after 2s). That's gone — PreviewScreen now renders ONE persistent pill,
 * top-right under the glass top bar, tied to the SAME `barsVisible` state as
 * the rest of the chrome rather than its own timer (and reused verbatim for
 * the photo swipe-pager's position counter — see `formatPdfPageCounter` in
 * `lib/preview-chrome.ts`). This component's only job now is to report page
 * info upward via `onPageInfo`.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Pdf from 'react-native-pdf';
import { useTheme } from '../../lib/theme-context';

interface PdfRendererProps {
  filePath: string;
  /** Fires on load and on every page change — current page (1-based) and
   * total page count. PreviewScreen owns the visible pill; this component
   * renders none of its own. */
  onPageInfo?: (info: { current: number; total: number }) => void;
}

export function PdfRenderer({ filePath, onPageInfo }: PdfRendererProps) {
  const [hasError, setHasError] = useState(false);
  const { colors } = useTheme();

  if (hasError) {
    // 1346 review finding — this status sits directly on PreviewScreen's
    // doc-branch `styles.root`, which follows the app's resolved scheme
    // (c.paper) since this task. `colors` here comes from useTheme(), so
    // it's already scheme-aware — the bug was reading `.white` (a fixed
    // extreme, #FFFFFF in both palettes) instead of the semantic
    // `.ink`/`.ink3` text tokens PreviewScreen's own error states use.
    return (
      <View style={styles.imageStatus}>
        <Text style={[styles.imageStatusTitle, { color: colors.ink }]}>
          Couldn't open PDF
        </Text>
        <Text style={[styles.imageStatusSub, { color: colors.ink3 }]}>
          This file may be damaged or unsupported.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pdf
        source={{ uri: filePath }}
        style={styles.pdf}
        enablePaging={false}
        horizontal={false}
        fitPolicy={0}
        spacing={8}
        enableAntialiasing
        onLoadComplete={(numberOfPages) => {
          onPageInfo?.({ current: 1, total: numberOfPages });
        }}
        onPageChanged={(page, numberOfPages) => {
          onPageInfo?.({ current: page, total: numberOfPages });
        }}
        onError={(error) => {
          console.error('PDF render error:', error);
          setHasError(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
  },
  pdf: {
    flex: 1,
  },
  imageStatus: {
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  imageStatusTitle: { fontSize: 16, fontWeight: '600' },
  imageStatusSub: { fontSize: 12, opacity: 0.85, textAlign: 'center' },
});
