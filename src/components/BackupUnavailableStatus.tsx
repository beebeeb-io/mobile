import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ANDROID_BACKUP_UNAVAILABLE_COPY } from '../lib/backup-platform-support';

export const BACKUP_UNAVAILABLE_STATUS_TEST_ID = 'backup-unavailable-android';

/**
 * Task 2303 — the honest Android replacement for every backup control.
 *
 * A plain, non-tappable status line: no switch, no link, nothing that looks
 * like it can turn backup on. Rendered by the Photos auto-backup pill and by
 * Settings → Backup whenever `isPhoneBackupSupported()` is false.
 */
export function BackupUnavailableStatus({
  color,
  style,
}: {
  color: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View testID={BACKUP_UNAVAILABLE_STATUS_TEST_ID} style={style}>
      <Text style={{ fontSize: 13, lineHeight: 18, color }}>
        {ANDROID_BACKUP_UNAVAILABLE_COPY}
      </Text>
    </View>
  );
}
