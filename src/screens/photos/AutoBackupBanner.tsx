import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useNavigation } from '@react-navigation/native';
import { GlassSurface, glassMaterial } from '../../components/glass';
import { BackupUnavailableStatus } from '../../components/BackupUnavailableStatus';
import { useBackup } from '../../lib/backup-context';
import { isPhoneBackupSupported } from '../../lib/backup-platform-support';
import { formatDate } from '../../lib/date-format';
import { useTheme } from '../../lib/theme-context';
import { useNetworkStatus } from '../../lib/useNetworkStatus';

/**
 * The Photos tab's auto-backup pill, extracted from `PhotosScreen` (task 2303)
 * so its Android state is render-testable without mounting the whole screen.
 *
 * 1429 — this banner renders in EVERY state (off/paused/active/done), always
 * floating directly above the native tab bar. Before that task it was a flat
 * opaque `View` (backgroundColor: c.paper2/c.amberBg, borderTopWidth hairline,
 * no radius, no horizontal inset) spanning the full screen width — exactly the
 * "second opaque band" Guus's screenshot showed sitting above the glass
 * capsule, off the shared glass-recipe system every other floating control in
 * this app already reads through (the select-mode action bar right below it,
 * the tab bar itself, FilesScreen's upload card). Now routed through the same
 * `GlassSurface radius="card"` (28pt, "the Live-Activity-style upload card" per
 * glass-recipe.ts) + inset margins UploadActivityCard already established, so
 * it reads as a floating card, not a band. See DEVIATIONS.md Phase 9 follow-up.
 */
export function AutoBackupBanner() {
  const { isPhotoBackupEnabled, backupProgress, lastBackupAt, includeVideos } = useBackup();
  const isConnected = useNetworkStatus();
  const { colors: c, resolved: scheme } = useTheme();
  const navigation = useNavigation<{ navigate: (name: string) => void }>();
  const material = glassMaterial(scheme);
  // No recipe token for an on-glass progress-track fill (same gap
  // UploadActivityCard's own local `track` const already covers) — same
  // literal pair reused here rather than inventing a second one.
  const track = scheme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';

  // Task 2303 — Android has no native backup engine, so this pill must not
  // offer "Enable in Settings" (which leads to toggles that cannot work).
  // Plain, non-tappable status line instead.
  if (!isPhoneBackupSupported()) {
    return (
      <View style={styles.bannerWrap}>
        <GlassSurface scheme={scheme} radius="card" contentStyle={styles.banner}>
          <BackupUnavailableStatus color={material.labelMuted} />
        </GlassSurface>
      </View>
    );
  }

  if (!isPhotoBackupEnabled) {
    return (
      <View style={styles.bannerWrap}>
        <GlassSurface scheme={scheme} radius="card" contentStyle={styles.banner}>
          <View style={[styles.bannerDot, { backgroundColor: c.ink4 }]} />
          <Text style={[styles.bannerText, { color: material.labelMuted }]}>Auto-backup off</Text>
          <TouchableOpacity
            activeOpacity={0.6}
            onPress={() => {
              Haptics.selectionAsync();
              navigation.navigate('Settings');
            }}
            accessibilityRole="link"
            accessibilityLabel="Enable auto-backup in Settings"
          >
            <Text style={[styles.bannerHint, { color: c.amberDeep, textDecorationLine: 'underline' }]}>
              Enable in Settings
            </Text>
          </TouchableOpacity>
        </GlassSurface>
      </View>
    );
  }

  if (!isConnected) {
    return (
      <View style={styles.bannerWrap}>
        <GlassSurface scheme={scheme} radius="card" contentStyle={styles.banner}>
          <View style={[styles.bannerDot, { backgroundColor: c.ink4 }]} />
          <Text style={[styles.bannerText, { color: material.labelMuted }]}>Backup paused</Text>
          <Text style={[styles.bannerHint, { color: material.labelMuted }]}>No connection</Text>
        </GlassSurface>
      </View>
    );
  }

  if (backupProgress.inProgress > 0) {
    const itemLabel = includeVideos ? 'items' : 'photos';
    const ratio = backupProgress.total > 0
      ? Math.min(1, Math.max(0, backupProgress.completed / backupProgress.total))
      : 0;
    return (
      <View style={styles.bannerWrap}>
        <GlassSurface scheme={scheme} radius="card" contentStyle={styles.bannerWithProgress}>
          <View style={styles.bannerHeaderRow}>
            <ActivityIndicator size="small" color={c.green} style={{ marginRight: 2 }} />
            <Text style={[styles.bannerText, { color: material.label }]}>
              {backupProgress.completed} of {backupProgress.total} {itemLabel} backed up
            </Text>
            <Text style={[styles.bannerHint, { color: material.labelMuted }]}>{Math.round(ratio * 100)}%</Text>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: track }]}>
            <View style={[styles.progressFill, { width: `${ratio * 100}%`, backgroundColor: c.amber }]} />
          </View>
        </GlassSurface>
      </View>
    );
  }

  const allDone = backupProgress.total > 0 && backupProgress.completed === backupProgress.total;
  return (
    <View style={styles.bannerWrap}>
      <GlassSurface scheme={scheme} radius="card" contentStyle={styles.banner}>
        <View style={[styles.bannerDot, { backgroundColor: c.green }]} />
        <Text style={[styles.bannerText, { color: material.label }]}>
          {allDone ? `All ${includeVideos ? 'items' : 'photos'} backed up` : 'Auto-backup on'}
        </Text>
        {lastBackupAt && (
          <Text style={[styles.bannerHint, { color: material.labelMuted }]}>
            {formatDate(lastBackupAt)}
          </Text>
        )}
      </GlassSurface>
    </View>
  );
}

// Moved verbatim from PhotosScreen's stylesheet along with the component.
// `bannerWrap` keeps its marginHorizontal: 14 (the glass card's own inset);
// `banner` is the single-line row the status pill reuses.
const styles = StyleSheet.create({
  bannerWrap: { marginHorizontal: 14 },
  banner: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  bannerWithProgress: { flexDirection: 'column', alignItems: 'stretch', paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  bannerHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerDot: { width: 6, height: 6, borderRadius: 3 },
  bannerText: { fontSize: 11, flex: 1 },
  bannerHint: { fontSize: 10, fontWeight: '600' },
  progressTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 2 },
});
