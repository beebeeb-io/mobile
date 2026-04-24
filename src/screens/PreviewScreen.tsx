import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../App';
import { colors, spacing } from '../theme';

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type PreviewRoute = RouteProp<RootStackParamList, 'Preview'>;

export default function PreviewScreen() {
  const navigation = useNavigation();
  const route = useRoute<PreviewRoute>();
  const { fileName } = route.params;

  const actions: { icon: string; label: string }[] = [
    { icon: '↗️', label: 'Share' },
    { icon: '⭐', label: 'Pin' },
    { icon: '📁', label: 'Move' },
    { icon: '🗑️', label: 'Delete' },
    { icon: '⋯', label: 'More' },
  ];

  return (
    <View style={styles.root}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backChevron}>{'‹'}</Text>
        </TouchableOpacity>
        <View style={styles.topCenter}>
          <Text style={styles.topTitle} numberOfLines={1}>
            {fileName}
          </Text>
          <Text style={styles.topSub}>3 of 24 {'·'} decrypting locally</Text>
        </View>
        <TouchableOpacity>
          <Text style={styles.topMore}>{'⋯'}</Text>
        </TouchableOpacity>
      </View>

      {/* Document preview area */}
      <View style={styles.previewArea}>
        <View style={styles.docPage}>
          <Text style={styles.docTitle}>AGREEMENT -- CONFIDENTIAL</Text>
          <View style={styles.docDivider} />
          <Text style={styles.docBody}>
            This agreement, dated the third of March, is between the parties below and remains
            confidential under the provisions set forth in Schedule A.
          </Text>
          <Text style={styles.docBodyFaded}>
            1. The parties hereby agree to the terms set forth. 2. Consideration shall be deemed
            delivered upon signature. 3. All disputes arising from
          </Text>
          <View style={[styles.docDivider, { marginVertical: 4 }]} />
          <View style={styles.highlight}>
            <Text style={styles.highlightText}>
              Highlighted: {'“'}{'…'}total consideration shall not exceed four million{'…'}{'”'}
            </Text>
          </View>
          <View style={{ flex: 1 }} />
          <Text style={styles.docPageNum}>Page 3 / 24 {'·'} redacted</Text>
        </View>
      </View>

      {/* Action bar */}
      <View style={styles.actionBar}>
        {actions.map((a, i) => (
          <TouchableOpacity key={i} style={styles.actionItem} activeOpacity={0.6}>
            <Text style={styles.actionIcon}>{a.icon}</Text>
            <Text style={styles.actionLabel}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.darkBg },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backChevron: { fontSize: 24, color: colors.paper },
  topCenter: { flex: 1, alignItems: 'center' },
  topTitle: { fontSize: 13, fontWeight: '600', color: colors.paper },
  topSub: { fontSize: 9.5, color: 'rgba(255,255,255,0.6)', marginTop: 2 },
  topMore: { fontSize: 18, color: colors.paper },

  // Preview area
  previewArea: {
    flex: 1,
    padding: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  docPage: {
    width: '100%',
    aspectRatio: 0.72,
    backgroundColor: '#f5f4f0',
    borderRadius: 4,
    padding: 18,
    paddingHorizontal: 16,
  },
  docTitle: {
    fontFamily: 'System',
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink,
  },
  docDivider: { height: 1, backgroundColor: colors.line2, marginVertical: 8 },
  docBody: {
    fontSize: 8,
    color: colors.ink2,
    lineHeight: 12,
    fontFamily: 'System',
  },
  docBodyFaded: {
    fontSize: 8,
    color: colors.ink3,
    lineHeight: 12,
    fontFamily: 'System',
    marginTop: 8,
  },
  highlight: {
    backgroundColor: colors.amberBg,
    padding: 4,
    borderLeftWidth: 2,
    borderLeftColor: colors.amberDeep,
  },
  highlightText: {
    fontSize: 8,
    color: colors.ink3,
    lineHeight: 12,
    fontFamily: 'System',
  },
  docPageNum: {
    fontSize: 8,
    color: colors.ink4,
    marginTop: 'auto',
  },

  // Action bar
  actionBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: 12,
    paddingBottom: 22,
    backgroundColor: colors.darkOverlay,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  actionItem: { alignItems: 'center' },
  actionIcon: { fontSize: 16, color: colors.paper, opacity: 0.85 },
  actionLabel: { fontSize: 9.5, color: colors.paper, opacity: 0.85, marginTop: 4 },
});
