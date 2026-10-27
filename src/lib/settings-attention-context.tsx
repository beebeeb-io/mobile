import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { getStorageUsage, type StorageUsage } from './api';
import { useBackup } from './backup-context';
import { computeSettingsAttention, type SettingsAttention } from './settings-attention';

export interface SettingsAttentionValue extends SettingsAttention {
  /** The one storage snapshot the badge and the Settings rows share. */
  usage: StorageUsage | null;
  /**
   * Re-read storage now. Resolves with the fresh usage, or null when the read
   * failed (the previous snapshot is kept) or a newer request superseded it.
   */
  refresh: () => Promise<StorageUsage | null>;
}

const SettingsAttentionContext = createContext<SettingsAttentionValue | null>(null);

/**
 * Task 2245 (P1) — ONE owner for the Settings attention snapshot.
 *
 * Before this provider, `TabNavigator` and `SettingsScreen` each mounted their
 * own `useSettingsAttention()`, so each held a separate storage state: a focus
 * refresh updated only Settings, and a failed fetch could leave the tab badge
 * "!" with no reason row (the original bug). The provider sits above the tab
 * navigator, owns the backup count and the storage usage, and both surfaces
 * read the same derived snapshot.
 *
 * Requests are sequenced: a slow older response cannot overwrite a newer one.
 * A failed read keeps the last known snapshot rather than inventing a reason.
 */
export function SettingsAttentionProvider({ children }: { children: React.ReactNode }) {
  const { backupProgress } = useBackup();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const requestSeq = useRef(0);

  const refresh = useCallback((): Promise<StorageUsage | null> => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    return getStorageUsage()
      .then((next) => {
        if (seq !== requestSeq.current) return null;
        setUsage(next);
        return next;
      })
      .catch(() => null);
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

  const value: SettingsAttentionValue = { ...attention, usage, refresh };
  return <SettingsAttentionContext.Provider value={value}>{children}</SettingsAttentionContext.Provider>;
}

export function useSettingsAttention(): SettingsAttentionValue {
  const value = useContext(SettingsAttentionContext);
  if (!value) {
    throw new Error('useSettingsAttention must be used inside SettingsAttentionProvider');
  }
  return value;
}
