import React, { useState } from 'react';
import {
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { colors, radii, spacing } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PhotoMonth {
  label: string;
  count: number;
  photos: { id: string; color: string; isVideo?: boolean; shared?: boolean }[];
}

// ---------------------------------------------------------------------------
// Deterministic warm-toned placeholder grid
// ---------------------------------------------------------------------------

function makeSwatch(row: number, col: number): string {
  const hues = [45, 30, 20, 55, 35, 50, 25, 40];
  const sats = [60, 50, 70, 45, 65, 55, 40, 50];
  const lights = [75, 60, 80, 68, 64, 78, 72, 66];
  const h = hues[(row * 3 + col) % hues.length];
  const s = sats[(row + col) % sats.length];
  const l = lights[(row * 2 + col) % lights.length];
  return `hsl(${h}, ${s}%, ${l}%)`;
}

function buildMonth(label: string, count: number, offset: number): PhotoMonth {
  const photos = Array.from({ length: count }, (_, i) => ({
    id: `${label}-${i}`,
    color: makeSwatch(Math.floor(i / 4) + offset, i % 4),
    isVideo: i === 0 && offset === 0,
    shared: i === 5,
  }));
  return { label, count, photos };
}

const MONTHS: PhotoMonth[] = [
  buildMonth('September 2025', 12, 0),
  buildMonth('August 2025', 8, 2),
];

const FILTERS = ['All', 'Years', 'Months', 'Days'] as const;
const DEFAULT_FILTER = 2; // Months

const SCREEN_WIDTH = Dimensions.get('window').width;
const GRID_GAP = 2;
const COLS = 4;
const CELL_SIZE = (SCREEN_WIDTH - GRID_GAP * (COLS + 1)) / COLS;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function PhotosScreen() {
  const [activeFilter, setActiveFilter] = useState(DEFAULT_FILTER);

  return (
    <View style={styles.root}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Photos</Text>
        <View style={{ flex: 1 }} />
        <TouchableOpacity style={styles.headerBtn}>
          <Text style={styles.headerBtnIcon}>?</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerBtn}>
          <Text style={styles.headerBtnIcon}>{'⋯'}</Text>
        </TouchableOpacity>
      </View>

      {/* Filter pills */}
      <View style={styles.filters}>
        {FILTERS.map((label, i) => {
          const active = i === activeFilter;
          return (
            <TouchableOpacity
              key={label}
              onPress={() => setActiveFilter(i)}
              style={[
                styles.pill,
                active ? styles.pillActive : styles.pillInactive,
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  active ? styles.pillTextActive : undefined,
                ]}
              >
                {label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Month grids */}
      <FlatList
        data={MONTHS}
        keyExtractor={(m) => m.label}
        renderItem={({ item: month }) => (
          <View style={styles.monthBlock}>
            <View style={styles.monthHeader}>
              <Text style={styles.monthLabel}>{month.label}</Text>
              <Text style={styles.monthCount}>{month.count} items</Text>
            </View>
            <View style={styles.grid}>
              {month.photos.map((photo) => (
                <View
                  key={photo.id}
                  style={[
                    styles.cell,
                    { backgroundColor: photo.color, width: CELL_SIZE, height: CELL_SIZE },
                  ]}
                >
                  {photo.isVideo && (
                    <View style={styles.videoBadge}>
                      <Text style={styles.videoBadgeText}>0:47</Text>
                    </View>
                  )}
                  {photo.shared && (
                    <View style={styles.sharedBadge}>
                      <Text style={styles.sharedBadgeIcon}>{'👥'}</Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          </View>
        )}
        ListFooterComponent={<View style={{ height: 80 }} />}
      />

      {/* Backup banner */}
      <View style={styles.backupBanner}>
        <Text style={styles.backupIcon}>{'↑'}</Text>
        <Text style={styles.backupText}>
          Auto-backup: <Text style={{ fontWeight: '700' }}>3 new</Text>
        </Text>
        <Text style={styles.backupMeta}>on Wi-Fi {'·'} 68%</Text>
      </View>
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
    paddingTop: 6,
  },
  title: { fontSize: 24, fontWeight: '700', color: colors.ink },
  headerBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  headerBtnIcon: { fontSize: 12, color: colors.ink2 },

  // Filters
  filters: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: spacing.lg,
    marginTop: 10,
    marginBottom: 10,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.round,
    borderWidth: 1,
  },
  pillActive: {
    backgroundColor: colors.ink,
    borderColor: colors.ink,
  },
  pillInactive: {
    backgroundColor: colors.paper2,
    borderColor: colors.line,
  },
  pillText: { fontSize: 11, color: colors.ink3, fontWeight: '400' },
  pillTextActive: { color: colors.paper, fontWeight: '600' },

  // Month grid
  monthBlock: { marginBottom: 12 },
  monthHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: spacing.lg,
    marginBottom: 6,
  },
  monthLabel: { fontSize: 13, fontWeight: '600', color: colors.ink },
  monthCount: { fontSize: 10, color: colors.ink3, marginLeft: 8 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
    paddingHorizontal: GRID_GAP,
  },
  cell: {
    borderRadius: 0,
    position: 'relative',
  },
  videoBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  videoBadgeText: { fontSize: 9, color: colors.paper },
  sharedBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sharedBadgeIcon: { fontSize: 6 },

  // Backup banner
  backupBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.amberBg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    gap: 8,
  },
  backupIcon: { fontSize: 11, color: colors.amberDeep },
  backupText: { fontSize: 11, color: colors.ink2, flex: 1 },
  backupMeta: { fontSize: 10, color: colors.amberDeep },
});
