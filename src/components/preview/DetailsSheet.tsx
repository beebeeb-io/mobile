/**
 * DetailsSheet — swipe-up metadata panel for file preview.
 *
 * A bottom sheet with a small drag handle (4px bar) visible by default.
 * Pull up to expand and see file metadata, crypto info, and actions.
 * Uses PanResponder (built-in, no extra dep) + Animated for spring physics.
 *
 * Follows the same dark-overlay styling as the existing media details sheet
 * in PreviewScreen.tsx.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { fonts } from '../../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetailsSheetProps {
  filename: string;
  kind: string;
  size: string;
  created?: string;
  modified?: string;
  extraInfo?: { label: string; value: string }[];
  crypto?: {
    cipher: string;
    keyType: string;
    ivPrefix: string;
    macVerified: boolean;
  };
  storageLocation?: string;
  onDownload?: () => void;
  onShare?: () => void;
  downloading?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How much of the sheet peeks above the bottom edge (just the handle). */
const COLLAPSED_VISIBLE_HEIGHT = 24;

/** The handle bar itself. */
const HANDLE_HEIGHT = 48;

/** Minimum expanded height regardless of screen size. */
const MIN_EXPANDED_HEIGHT = 320;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DetailsSheet({
  filename,
  kind,
  size,
  created,
  modified,
  extraInfo,
  crypto,
  storageLocation,
  onDownload,
  onShare,
  downloading,
}: DetailsSheetProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = Dimensions.get('window');

  const [expanded, setExpanded] = useState(false);
  const animValue = useRef(new Animated.Value(0)).current;
  const touchStartY = useRef<number | null>(null);

  // Geometry
  const safeBottom = Math.max(insets.bottom, 16);
  const expandedHeight = Math.min(
    Math.max(MIN_EXPANDED_HEIGHT, Math.round(windowHeight * 0.6)),
    windowHeight - insets.top - 60,
  );
  const collapsedVisibleHeight = COLLAPSED_VISIBLE_HEIGHT + safeBottom;

  // Animate open/close
  useEffect(() => {
    Animated.spring(animValue, {
      toValue: expanded ? 1 : 0,
      damping: 24,
      stiffness: 220,
      mass: 0.9,
      useNativeDriver: true,
    }).start();
  }, [animValue, expanded]);

  const translateY = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [expandedHeight - collapsedVisibleHeight, 0],
  });

  // Gesture — PanResponder for drag up/down
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_evt, gesture) =>
          Math.abs(gesture.dy) > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_evt, gesture) => {
          if (gesture.dy < -28 || gesture.vy < -0.6) {
            setExpanded(true);
          } else if (gesture.dy > 28 || gesture.vy > 0.6) {
            setExpanded(false);
          }
        },
      }),
    [],
  );

  // Fallback touch tracking for tap-to-toggle
  const handleTouchStart = useCallback((event: GestureResponderEvent) => {
    touchStartY.current = event.nativeEvent.pageY;
  }, []);

  const handleTouchEnd = useCallback((event: GestureResponderEvent) => {
    const startY = touchStartY.current;
    touchStartY.current = null;
    if (startY == null) return;

    const deltaY = event.nativeEvent.pageY - startY;
    if (deltaY < -24) {
      setExpanded(true);
    } else if (deltaY > 24) {
      setExpanded(false);
    }
  }, []);

  // Build metadata rows
  const rows = useMemo(() => {
    const result: { label: string; value: string; mono?: boolean }[] = [
      { label: 'Name', value: filename },
      { label: 'Kind', value: kind },
      { label: 'Size', value: size },
    ];
    if (created) result.push({ label: 'Created', value: created });
    if (modified) result.push({ label: 'Modified', value: modified });
    if (extraInfo) {
      for (const info of extraInfo) {
        result.push({ label: info.label, value: info.value });
      }
    }
    if (crypto) {
      result.push({ label: 'Cipher', value: crypto.cipher, mono: true });
      result.push({ label: 'Key type', value: crypto.keyType, mono: true });
      result.push({ label: 'IV prefix', value: crypto.ivPrefix, mono: true });
      result.push({
        label: 'MAC',
        value: crypto.macVerified ? 'Verified' : 'Not verified',
      });
    }
    if (storageLocation) {
      result.push({ label: 'Storage', value: storageLocation });
    }
    return result;
  }, [filename, kind, size, created, modified, extraInfo, crypto, storageLocation]);

  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          height: expandedHeight,
          paddingBottom: safeBottom,
          transform: [{ translateY }],
        },
      ]}
      {...panResponder.panHandlers}
    >
      {/* Handle area — tap or drag */}
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => setExpanded((v) => !v)}
        onPressIn={handleTouchStart}
        onPressOut={handleTouchEnd}
        style={styles.handleArea}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide file details' : 'Show file details'}
      >
        <View style={styles.grabber} />
        <View style={styles.summaryRow}>
          <View style={styles.summaryText}>
            <Text style={styles.title}>Details</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {expanded ? filename : 'Swipe up for metadata'}
            </Text>
          </View>
          <Ionicons
            name={expanded ? 'chevron-down' : 'chevron-up'}
            size={18}
            color="rgba(255,255,255,0.72)"
          />
        </View>
      </TouchableOpacity>

      {/* Action buttons */}
      {(onShare || onDownload) && (
        <View style={styles.actionsRow}>
          {onShare && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={onShare}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Share Beebeeb link"
            >
              <Ionicons name="link-outline" size={19} color="#FFFFFF" />
              <Text style={styles.actionText}>Share link</Text>
            </TouchableOpacity>
          )}
          {onDownload && (
            <TouchableOpacity
              style={[styles.actionButton, downloading && styles.actionButtonDisabled]}
              onPress={onDownload}
              activeOpacity={0.8}
              disabled={downloading}
              accessibilityRole="button"
              accessibilityLabel="Export to another app"
            >
              {downloading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="share-outline" size={19} color="#FFFFFF" />
              )}
              <Text style={styles.actionText}>Export</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Scrollable metadata rows */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.rowsContainer}>
          {rows.map((row) => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text
                style={[
                  styles.rowValue,
                  row.mono && { fontFamily: fonts.mono, fontSize: 11 },
                ]}
                numberOfLines={2}
              >
                {row.value}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Styles — matches the dark-overlay aesthetic of PreviewScreen's media sheet
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 30,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: 'rgba(22,22,24,0.96)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  handleArea: {
    minHeight: HANDLE_HEIGHT,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  summaryText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
  },
  subtitle: {
    marginTop: 2,
    color: 'rgba(255,255,255,0.52)',
    fontSize: 12,
    lineHeight: 16,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  actionButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
  },
  scrollArea: {
    flex: 1,
    marginTop: 14,
  },
  scrollContent: {
    paddingBottom: 10,
  },
  rowsContainer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  row: {
    minHeight: 38,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  rowLabel: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  rowValue: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'right',
    fontWeight: '600',
  },
});
