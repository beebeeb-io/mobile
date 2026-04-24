import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radii, spacing } from '../theme';
import type { RootStackParamList } from '../App';

// ---------------------------------------------------------------------------
// Mock data -- will be replaced by API calls once crypto bindings land
// ---------------------------------------------------------------------------

interface PinnedFolder {
  id: string;
  name: string;
  count: number;
}

interface RecentFile {
  id: string;
  name: string;
  type: 'folder' | 'doc' | 'pdf' | 'audio' | 'image';
  age: string;
  dot?: boolean;
  warn?: string;
}

const PINNED: PinnedFolder[] = [
  { id: '1', name: 'Ledger gap', count: 23 },
  { id: '2', name: 'Source docs', count: 128 },
];

const RECENT: RecentFile[] = [
  { id: '3', name: 'story-draft.md', type: 'doc', age: '4m', dot: true },
  { id: '4', name: 'interview-03.m4a', type: 'audio', age: '2h' },
  { id: '5', name: 'leak-packet.pdf', type: 'pdf', age: '6h', warn: 'One-time view · 47h left' },
  { id: '6', name: 'photo-evidence/', type: 'folder', age: 'yest.' },
];

// ---------------------------------------------------------------------------
// File icon helper
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, string> = {
  folder: colors.amberDeep,
  doc: colors.ink2,
  pdf: colors.red,
  audio: colors.green,
  image: colors.amber,
};

function FileIcon({ type }: { type: string }) {
  const bg = TYPE_COLORS[type] ?? colors.ink3;
  const label = type.slice(0, 3).toUpperCase();
  return (
    <View style={[styles.fileIcon, { backgroundColor: bg }]}>
      <Text style={styles.fileIconText}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function FilesScreen() {
  const navigation = useNavigation<Nav>();
  const [pinned] = useState(PINNED);
  const [recent] = useState(RECENT);

  const openPreview = useCallback(
    (fileId: string, fileName: string) => {
      navigation.navigate('Preview', { fileId, fileName });
    },
    [navigation],
  );

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>IM</Text>
        </View>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.headerBtn}>
          <Text style={styles.headerBtnIcon}>?</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.headerBtn, styles.headerBtnPrimary]}>
          <Text style={[styles.headerBtnIcon, { color: colors.paper }]}>+</Text>
        </TouchableOpacity>
      </View>

      {/* Title + region */}
      <Text style={styles.title}>Drive</Text>
      <View style={styles.regionRow}>
        <View style={styles.regionBadge}>
          <Text style={styles.regionText}>Frankfurt</Text>
        </View>
        <Text style={styles.storageText}>{'·'} 23.4 / 200 GB</Text>
      </View>

      {/* Pinned folders */}
      <Text style={styles.sectionLabel}>Pinned</Text>
      <View style={styles.pinnedGrid}>
        {pinned.map((p) => (
          <TouchableOpacity key={p.id} style={styles.pinnedCard} activeOpacity={0.7}>
            <Text style={styles.pinnedIcon}>{'📁'}</Text>
            <Text style={styles.pinnedName}>{p.name}</Text>
            <Text style={styles.pinnedCount}>{p.count} files</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Recent files */}
      <View style={styles.recentHeader}>
        <Text style={styles.sectionLabel}>Recent</Text>
        <TouchableOpacity>
          <Text style={styles.seeAll}>See all</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={recent}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.recentRow}
            activeOpacity={0.6}
            onPress={() => openPreview(item.id, item.name)}
          >
            <FileIcon type={item.type} />
            <View style={styles.recentInfo}>
              <View style={styles.recentNameRow}>
                <Text style={styles.recentName} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.dot && <View style={styles.dot} />}
              </View>
              <Text
                style={[
                  styles.recentMeta,
                  item.warn ? { color: colors.red } : undefined,
                ]}
              >
                {item.warn ?? item.age}
              </Text>
            </View>
            <Text style={styles.chevron}>{'›'}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: 6,
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.amberDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.paper, fontSize: 11, fontWeight: '700' },
  headerBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnPrimary: {
    backgroundColor: colors.amber,
    borderColor: colors.amber,
  },
  headerBtnIcon: { fontSize: 14, color: colors.ink2, fontWeight: '600' },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.ink,
    paddingHorizontal: spacing.lg,
    marginTop: 4,
  },
  regionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    gap: 6,
    marginBottom: spacing.md,
  },
  regionBadge: {
    backgroundColor: colors.amberBg,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.round,
    borderWidth: 1,
    borderColor: colors.line,
  },
  regionText: { fontSize: 10, fontWeight: '600', color: colors.amberDeep },
  storageText: { fontSize: 10, color: colors.ink3, fontFamily: 'System' },

  sectionLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.lg,
    marginBottom: 6,
  },

  // Pinned
  pinnedGrid: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  pinnedCard: {
    flex: 1,
    padding: 10,
    borderRadius: radii.lg,
    backgroundColor: colors.amberBg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  pinnedIcon: { fontSize: 14 },
  pinnedName: { fontSize: 12, fontWeight: '600', color: colors.ink, marginTop: 6 },
  pinnedCount: { fontSize: 9.5, color: colors.ink3 },

  // Recent
  recentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: 4,
  },
  seeAll: { fontSize: 11, color: colors.amberDeep, marginLeft: 'auto' },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    gap: 11,
  },
  fileIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileIconText: { color: colors.paper, fontSize: 8, fontWeight: '700' },
  recentInfo: { flex: 1, minWidth: 0 },
  recentNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recentName: { fontSize: 13, fontWeight: '500', color: colors.ink },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.amberDeep,
  },
  recentMeta: { fontSize: 10, color: colors.ink3, marginTop: 2 },
  chevron: { fontSize: 18, color: colors.ink4 },
});
