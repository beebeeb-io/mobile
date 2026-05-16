/**
 * PptxRenderer — simple slide viewer for PPTX files.
 *
 * PPTX is a ZIP of XML files. Uses JSZip to extract slide XML files
 * (ppt/slides/slide1.xml, slide2.xml, ...) and parses <a:t> text tags
 * for content. Renders slides in a horizontal FlatList (swipe between slides).
 *
 * Text-only — no images, shapes, or animations. Good enough for quick
 * preview of presentation content without downloading the full file.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import JSZip from 'jszip';
import { fonts, radii } from '../../theme';
import type { Colors } from '../../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlideContent {
  /** 1-based slide number */
  number: number;
  /** Text blocks extracted from the slide XML */
  textBlocks: string[];
}

// ---------------------------------------------------------------------------
// PPTX parser
// ---------------------------------------------------------------------------

/**
 * Extract text content from all slides in a PPTX file.
 * PPTX is a ZIP containing XML files at ppt/slides/slideN.xml.
 * Each slide's text lives inside <a:t> elements within the XML.
 */
async function parsePptx(arrayBuffer: ArrayBuffer): Promise<SlideContent[]> {
  const zip = await JSZip.loadAsync(arrayBuffer);

  // Find all slide files and sort by number
  const slideFiles: { name: string; number: number }[] = [];
  zip.forEach((relativePath) => {
    const match = relativePath.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (match) {
      slideFiles.push({ name: relativePath, number: parseInt(match[1], 10) });
    }
  });

  slideFiles.sort((a, b) => a.number - b.number);

  const slides: SlideContent[] = [];

  for (const slideFile of slideFiles) {
    const file = zip.file(slideFile.name);
    if (!file) continue;

    const xmlStr = await file.async('string');
    const textBlocks = extractTextFromXml(xmlStr);

    slides.push({
      number: slideFile.number,
      textBlocks,
    });
  }

  return slides;
}

/**
 * Extract text from OOXML by pulling content from <a:t> tags.
 * Groups text by paragraph (<a:p>) — each paragraph becomes one text block.
 *
 * Uses regex-based parsing because DOMParser is not available in React Native.
 * This is intentionally simple and handles the common case well.
 */
function extractTextFromXml(xml: string): string[] {
  const blocks: string[] = [];

  // Split by paragraph tags to group text logically
  const paragraphs = xml.split(/<a:p[ >]/);

  for (const para of paragraphs) {
    // Find all <a:t>...</a:t> within this paragraph
    const textMatches = para.match(/<a:t>([\s\S]*?)<\/a:t>/g);
    if (!textMatches || textMatches.length === 0) continue;

    // Concatenate all text runs in this paragraph
    const paraText = textMatches
      .map((m) => {
        const inner = m.replace(/<a:t>([\s\S]*?)<\/a:t>/, '$1');
        return decodeXmlEntities(inner);
      })
      .join('');

    const trimmed = paraText.trim();
    if (trimmed.length > 0) {
      blocks.push(trimmed);
    }
  }

  return blocks;
}

/** Decode common XML entities. */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PptxRendererProps {
  /** Raw PPTX file bytes as an ArrayBuffer */
  data: ArrayBuffer;
  /** Theme colors from useTheme() */
  colors: Colors;
}

export function PptxRenderer({ data, colors: c }: PptxRendererProps) {
  const [slides, setSlides] = useState<SlideContent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentSlide, setCurrentSlide] = useState(0);
  const { width: screenWidth } = Dimensions.get('window');
  const slideWidth = screenWidth - 32; // 16px padding on each side

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError(null);

        const result = await parsePptx(data);
        if (!cancelled) setSlides(result);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to read PPTX file',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data]);

  const renderSlide = useMemo(
    () =>
      ({ item }: { item: SlideContent }) => (
        <View style={[styles.slideWrapper, { width: slideWidth }]}>
          <View
            style={[
              styles.slideCard,
              { backgroundColor: c.paper, borderColor: c.line },
            ]}
          >
            <View style={styles.slideHeader}>
              <Text style={[styles.slideNumber, { color: c.ink3 }]}>
                Slide {item.number}
              </Text>
            </View>
            {item.textBlocks.length === 0 ? (
              <View style={styles.slideEmpty}>
                <Text style={[styles.slideEmptyText, { color: c.ink4 }]}>
                  No text content
                </Text>
              </View>
            ) : (
              <View style={styles.slideContent}>
                {item.textBlocks.map((text, i) => {
                  // First non-empty text block is typically the title
                  const isTitle = i === 0;
                  return (
                    <Text
                      key={i}
                      style={[
                        isTitle ? styles.slideTitle : styles.slideText,
                        { color: c.ink },
                      ]}
                    >
                      {text}
                    </Text>
                  );
                })}
              </View>
            )}
          </View>
        </View>
      ),
    [c, slideWidth],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={c.amber} size="large" />
        <Text style={[styles.statusText, { color: c.ink3 }]}>
          Extracting slides...
        </Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.errorTitle, { color: c.ink }]}>
          Couldn't open presentation
        </Text>
        <Text style={[styles.statusText, { color: c.ink3 }]}>{error}</Text>
      </View>
    );
  }

  if (slides.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={[styles.errorTitle, { color: c.ink }]}>
          Empty presentation
        </Text>
        <Text style={[styles.statusText, { color: c.ink3 }]}>
          No slides found in this PPTX file.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={slides}
        keyExtractor={(item) => `slide-${item.number}`}
        renderItem={renderSlide}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        snapToInterval={slideWidth + 16} // slideWidth + gap
        snapToAlignment="center"
        decelerationRate="fast"
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        onMomentumScrollEnd={(e) => {
          const index = Math.round(
            e.nativeEvent.contentOffset.x / (slideWidth + 16),
          );
          setCurrentSlide(Math.max(0, Math.min(index, slides.length - 1)));
        }}
      />

      {/* Page indicator */}
      {slides.length > 1 && (
        <View style={[styles.indicator, { backgroundColor: c.paper2 }]}>
          <Text style={[styles.indicatorText, { color: c.ink2 }]}>
            {currentSlide + 1} / {slides.length}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: '100%',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusText: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  separator: {
    width: 16,
  },
  slideWrapper: {
    flex: 1,
    justifyContent: 'center',
  },
  slideCard: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    // 16:9 aspect ratio feel without hard constraint
    minHeight: 200,
  },
  slideHeader: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  slideNumber: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.mono,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  slideContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
  },
  slideTitle: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  slideText: {
    fontSize: 14,
    lineHeight: 20,
  },
  slideEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  slideEmptyText: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  indicator: {
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
  indicatorText: {
    fontSize: 12,
    fontFamily: fonts.mono,
    fontVariant: ['tabular-nums'],
  },
});
