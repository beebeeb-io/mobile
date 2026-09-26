import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { radii } from '../theme';
import { useTheme } from '../lib/theme-context';
import { useThumbnail } from '../lib/use-thumbnail';
import { fileThumbnailState } from '../lib/locked-thumbnail';
import { Icon } from './Icon';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const CATEGORY_ICONS: Record<string, IoniconName> = {
  folder: 'folder',
  image: 'image',
  pdf: 'document-text',
  audio: 'musical-notes',
  video: 'videocam',
  doc: 'document',
  file: 'document-outline',
};

export interface FileIconProps {
  category: string;
  size?: number;
  fileId?: string;
  hasThumbnail?: boolean;
  /**
   * The file is in the "Lock file" list: never load or draw its thumbnail,
   * draw a lock placeholder instead (flow iOS-core issue 3).
   */
  locked?: boolean;
  /**
   * False while the lock list is still being read from SecureStore. Until
   * then no thumbnail is loaded (fail closed) and no lock glyph is drawn.
   * Defaults to true for callers that have no lock state to wait for.
   */
  lockStateReady?: boolean;
}

// File row / grid card / Recent tile icon. Moved out of FilesScreen.tsx so it
// can be rendered in isolation by a unit test.
export const FileIcon = React.memo(function FileIcon({
  category, size = 32, fileId, hasThumbnail, locked = false, lockStateReady = true,
}: FileIconProps) {
  const { colors: c } = useTheme();
  const { loadThumbnail, showLockPlaceholder } = fileThumbnailState(locked, lockStateReady);

  // 1321 — was a hand-rolled effect calling fetchDecryptedThumbnailUri, which
  // throws unconditionally on iOS since the BeebeebThumbnails migration. It was
  // wrapped in `catch { /* non-fatal */ }`, so instead of failing it silently
  // returned no thumbnail for EVERY non-PhotoKit file and the row fell back to
  // a category icon. useThumbnail is the migrated path: it routes iOS through
  // the native service and keeps the PhotoKit short-circuit that task 0563
  // added (never overwrite the higher-quality PhotoKit render with the
  // lower-quality server thumbnail).
  const { uri: thumbUri } = useThumbnail(fileId ?? '', {
    enabled: Boolean(fileId && hasThumbnail) && loadThumbnail,
    hasThumbnail: Boolean(hasThumbnail),
    width: size * 3,
    height: size * 3,
  });
  const CATEGORY_COLORS: Record<string, string> = {
    folder: c.amberDeep,
    image: c.amber,
    pdf: c.red,
    audio: c.green,
    video: c.ink2,
    doc: c.ink2,
    file: c.ink3,
  };
  const bg = CATEGORY_COLORS[category] ?? c.ink3;
  const icon: IoniconName = CATEGORY_ICONS[category] ?? 'document-outline';
  const iconSize = Math.round(size * 0.5);
  const borderRadius = size >= 48 ? radii.lg : size >= 40 ? radii.md : radii.sm;
  if (showLockPlaceholder) {
    // Neutral paper tile + lock glyph; deliberately not amber (amber is for
    // encryption state and primary actions only).
    return (
      <View
        testID={fileId ? `file-icon-locked-${fileId}` : undefined}
        accessibilityLabel="Locked file"
        style={[styles.fileIcon, { backgroundColor: c.paper2, borderColor: c.line, borderWidth: StyleSheet.hairlineWidth, width: size, height: size, borderRadius }]}
      >
        <Icon name="lock" size={iconSize} color={c.ink3} />
      </View>
    );
  }
  if (thumbUri && loadThumbnail) {
    return (
      <Image
        source={{ uri: thumbUri }}
        style={[styles.fileIcon, { width: size, height: size, borderRadius }]}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[styles.fileIcon, { backgroundColor: bg, width: size, height: size, borderRadius }]}>
      <Ionicons name={icon} size={iconSize} color="#FFFFFF" />
    </View>
  );
});

const styles = StyleSheet.create({
  fileIcon: { alignItems: 'center', justifyContent: 'center' },
});
