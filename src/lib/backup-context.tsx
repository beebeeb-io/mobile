import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

const BACKUP_ENABLED_KEY = 'beebeeb_backup_enabled';
const LAST_BACKUP_KEY = 'beebeeb_last_backup_at';

interface BackupProgress {
  total: number;
  completed: number;
  inProgress: number;
}

export interface BackupContextValue {
  isBackupEnabled: boolean;
  toggleBackup: () => Promise<void>;
  backupProgress: BackupProgress;
  lastBackupAt: string | null;
}

export const BackupContext = createContext<BackupContextValue>({
  isBackupEnabled: false,
  toggleBackup: async () => {},
  backupProgress: { total: 0, completed: 0, inProgress: 0 },
  lastBackupAt: null,
});

export function BackupProvider({ children }: { children: React.ReactNode }) {
  const [isBackupEnabled, setIsBackupEnabled] = useState(false);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);

  // backupProgress will be driven by native PhotoBackupManager once wired up
  const backupProgress: BackupProgress = { total: 0, completed: 0, inProgress: 0 };

  useEffect(() => {
    (async () => {
      try {
        const enabled = await SecureStore.getItemAsync(BACKUP_ENABLED_KEY);
        setIsBackupEnabled(enabled === 'true');
        const lastAt = await SecureStore.getItemAsync(LAST_BACKUP_KEY);
        setLastBackupAt(lastAt);
      } catch {
        // SecureStore unavailable (web / unit tests)
      }
    })();
  }, []);

  const toggleBackup = useCallback(async () => {
    const next = !isBackupEnabled;
    setIsBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_ENABLED_KEY, next ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
  }, [isBackupEnabled]);

  return (
    <BackupContext.Provider value={{ isBackupEnabled, toggleBackup, backupProgress, lastBackupAt }}>
      {children}
    </BackupContext.Provider>
  );
}

export function useBackup(): BackupContextValue {
  return useContext(BackupContext);
}
