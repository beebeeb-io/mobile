import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  enablePhotoBackup,
  disablePhotoBackup,
  enableContactsBackup,
  disableContactsBackup,
  enableCalendarBackup,
  disableCalendarBackup,
  getBackupProgress,
  triggerImmediateBackup,
  type NativeBackupProgress,
} from '../../modules/beebeeb-crypto';

const BACKUP_PHOTO_KEY = 'beebeeb_camera_backup';
const BACKUP_CONTACTS_KEY = 'beebeeb_contacts_backup';
const BACKUP_CALENDAR_KEY = 'beebeeb_calendar_backup';
const SESSION_TOKEN_KEY = 'beebeeb_session_token';

interface BackupProgress {
  total: number;
  completed: number;
  inProgress: number;
}

export interface BackupContextValue {
  isPhotoBackupEnabled: boolean;
  isContactsBackupEnabled: boolean;
  isCalendarBackupEnabled: boolean;
  togglePhotoBackup: () => Promise<void>;
  toggleContactsBackup: () => Promise<void>;
  toggleCalendarBackup: () => Promise<void>;
  backupProgress: BackupProgress;
  lastBackupAt: string | null;
  triggerBackupNow: () => Promise<void>;
  // Legacy alias for components that used the old API
  isBackupEnabled: boolean;
  toggleBackup: () => Promise<void>;
}

export const BackupContext = createContext<BackupContextValue>({
  isPhotoBackupEnabled: false,
  isContactsBackupEnabled: false,
  isCalendarBackupEnabled: false,
  togglePhotoBackup: async () => {},
  toggleContactsBackup: async () => {},
  toggleCalendarBackup: async () => {},
  backupProgress: { total: 0, completed: 0, inProgress: 0 },
  lastBackupAt: null,
  triggerBackupNow: async () => {},
  isBackupEnabled: false,
  toggleBackup: async () => {},
});

async function getStoredToken(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') {
      return typeof window !== 'undefined' ? window.localStorage.getItem(SESSION_TOKEN_KEY) : null;
    }
    return await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function BackupProvider({ children }: { children: React.ReactNode }) {
  const [isPhotoBackupEnabled, setIsPhotoBackupEnabled] = useState(false);
  const [isContactsBackupEnabled, setIsContactsBackupEnabled] = useState(false);
  const [isCalendarBackupEnabled, setIsCalendarBackupEnabled] = useState(false);
  const [backupProgress, setBackupProgress] = useState<BackupProgress>({ total: 0, completed: 0, inProgress: 0 });
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load persisted preferences on mount
  useEffect(() => {
    (async () => {
      try {
        const [photo, contacts, calendar] = await Promise.all([
          SecureStore.getItemAsync(BACKUP_PHOTO_KEY),
          SecureStore.getItemAsync(BACKUP_CONTACTS_KEY),
          SecureStore.getItemAsync(BACKUP_CALENDAR_KEY),
        ]);
        setIsPhotoBackupEnabled(photo === 'true');
        setIsContactsBackupEnabled(contacts === 'true');
        setIsCalendarBackupEnabled(calendar === 'true');
      } catch {
        // SecureStore unavailable (web / unit tests)
      }
    })();
  }, []);

  // Poll native backup progress every 5 s when photo backup is enabled
  useEffect(() => {
    if (!isPhotoBackupEnabled || Platform.OS === 'web') return;

    const poll = async () => {
      try {
        const p: NativeBackupProgress = await getBackupProgress();
        setBackupProgress({ total: p.total, completed: p.completed, inProgress: p.inProgress });
        if (p.lastBackupAt) setLastBackupAt(p.lastBackupAt);
      } catch {
        // Native module not linked yet — ignore
      }
    };

    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isPhotoBackupEnabled]);

  const togglePhotoBackup = useCallback(async () => {
    const next = !isPhotoBackupEnabled;
    setIsPhotoBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_PHOTO_KEY, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          const token = await getStoredToken();
          if (token) await enablePhotoBackup(token);
        } else {
          await disablePhotoBackup();
          setBackupProgress({ total: 0, completed: 0, inProgress: 0 });
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [isPhotoBackupEnabled]);

  const toggleContactsBackup = useCallback(async () => {
    const next = !isContactsBackupEnabled;
    setIsContactsBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_CONTACTS_KEY, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          const token = await getStoredToken();
          if (token) await enableContactsBackup(token);
        } else {
          await disableContactsBackup();
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [isContactsBackupEnabled]);

  const toggleCalendarBackup = useCallback(async () => {
    const next = !isCalendarBackupEnabled;
    setIsCalendarBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_CALENDAR_KEY, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          const token = await getStoredToken();
          if (token) await enableCalendarBackup(token);
        } else {
          await disableCalendarBackup();
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [isCalendarBackupEnabled]);

  const triggerBackupNow = useCallback(async () => {
    try {
      const token = await getStoredToken();
      if (token && Platform.OS !== 'web') {
        await triggerImmediateBackup(token);
      }
    } catch {
      // Native module not linked yet
    }
  }, []);

  return (
    <BackupContext.Provider value={{
      isPhotoBackupEnabled,
      isContactsBackupEnabled,
      isCalendarBackupEnabled,
      togglePhotoBackup,
      toggleContactsBackup,
      toggleCalendarBackup,
      backupProgress,
      lastBackupAt,
      triggerBackupNow,
      // Legacy alias
      isBackupEnabled: isPhotoBackupEnabled,
      toggleBackup: togglePhotoBackup,
    }}>
      {children}
    </BackupContext.Provider>
  );
}

export function useBackup(): BackupContextValue {
  return useContext(BackupContext);
}
