import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { getStorageUsage, type StorageUsage } from './api';
import { useBackup } from './backup-context';
import { computeSettingsAttention, type SettingsAttention } from './settings-attention';

export interface SettingsAttentionValue extends SettingsAttention {
  /** Re-read storage now (Settings calls this when the screen gains focus). */
  refresh: () => void;
}

/**
 * Task 2245 (P1) — the one hook behind the Settings tab badge and the
 * Settings root rows.
 *
 * Storage was previously fetched ONCE on mount in `TabNavigator`, so the
 * badge could stay on for the whole process after the user freed space. The
 * hook re-reads on every foreground transition, and exposes `refresh()` for
 * the Settings focus effect. A failed read is ignored: the last known usage
 * stays, and the backup reason is never cleared by an unrelated error.
 */
export function useSettingsAttention(): SettingsAttentionValue {
  const { backupProgress } = useBackup();
  const [usage, setUsage] = useState<StorageUsage | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    getStorageUsage()
      .then((next) => { if (!cancelled) setUsage(next); })
      .catch(() => { /* keep the last known usage */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const attention = computeSettingsAttention({
    backupFailedCount: backupProgress?.failed ?? 0,
    usedBytes: usage?.used_bytes,
    limitBytes: usage?.plan_limit_bytes,
  });

  return { ...attention, refresh };
}
