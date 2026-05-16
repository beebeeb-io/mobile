/**
 * PdfRenderer — multi-page PDF viewer with vertical scroll.
 *
 * Uses react-native-pdf for native rendering with pinch-to-zoom.
 * Floating page indicator appears while scrolling and fades after 2 seconds.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, StyleSheet, Text, View } from 'react-native';
import Pdf from 'react-native-pdf';
import { fonts } from '../../theme';
import { useTheme } from '../../lib/theme-context';

interface PdfRendererProps {
  filePath: string;
}

const INDICATOR_FADE_MS = 2000;

export function PdfRenderer({ filePath }: PdfRendererProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const { colors } = useTheme();
  const { width } = Dimensions.get('window');

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showIndicator = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true,
    }).start();

    hideTimer.current = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }, INDICATOR_FADE_MS);
  }, [fadeAnim]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  return (
    <View style={styles.container}>
      <Pdf
        source={{ uri: filePath }}
        style={[styles.pdf, { width }]}
        enablePaging={false}
        horizontal={false}
        fitPolicy={2}
        spacing={8}
        enableAntialiasing
        onLoadComplete={(numberOfPages) => {
          setTotalPages(numberOfPages);
        }}
        onPageChanged={(page) => {
          setCurrentPage(page);
          if (totalPages > 1) showIndicator();
        }}
        onError={(error) => {
          console.error('PDF render error:', error);
        }}
      />
      {totalPages > 1 && (
        <Animated.View
          style={[
            styles.pageIndicator,
            {
              backgroundColor: colors.paper2,
              opacity: fadeAnim,
            },
          ]}
          pointerEvents="none"
        >
          <Text style={[styles.pageText, { color: colors.ink2 }]}>
            Page {currentPage} of {totalPages}
          </Text>
        </Animated.View>
      )}
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
  pageIndicator: {
    position: 'absolute',
    bottom: 16,
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  pageText: {
    fontSize: 12,
    fontFamily: fonts.mono,
    fontVariant: ['tabular-nums'],
  },
});
