import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  configureBackupFolder,
  disablePhotoBackup,
  disableContactsBackup,
  disableCalendarBackup,
  enablePhotoBackup,
  enableContactsBackup,
  enableCalendarBackup,
  resumeContactsBackup,
  resumeCalendarBackup,
  getBackupProgress,
  triggerImmediateBackup,
  type NativeBackupProgress,
} from '../../modules/beebeeb-crypto';
import { ensureBackupFolders, type BackupCategory } from '../services/BackupService';
import { useCrypto } from './crypto-context';
import { recordRuntimeTrace } from './runtime-trace';

const BACKUP_PHOTO_KEY = 'beebeeb_camera_backup';
const BACKUP_CONTACTS_KEY = 'beebeeb_contacts_backup';
const BACKUP_CALENDAR_KEY = 'beebeeb_calendar_backup';
const BACKUP_INCLUDE_VIDEOS_KEY = 'beebeeb_camera_include_videos';
const BACKUP_WIFI_ONLY_KEY = 'beebeeb_camera_wifi_only';
const BACKUP_BG_UPLOAD_KEY = 'beebeeb_camera_bg_upload';
const SESSION_TOKEN_KEY = 'beebeeb_session_token';

interface BackupProgress {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  waitingToEncrypt?: number;
  encryptedPendingUpload?: number;
  uploading?: number;
  failed: number;
  state: string;
  reason: string;
}

export interface BackupContextValue {
  isPhotoBackupEnabled: boolean;
  isContactsBackupEnabled: boolean;
  isCalendarBackupEnabled: boolean;
  togglePhotoBackup: () => Promise<void>;
  toggleContactsBackup: () => Promise<void>;
  toggleCalendarBackup: () => Promise<void>;
  // Camera backup options
  includeVideos: boolean;
  wifiOnly: boolean;
  backgroundUpload: boolean;
  setIncludeVideos: (value: boolean) => Promise<void>;
  setWifiOnly: (value: boolean) => Promise<void>;
  setBackgroundUpload: (value: boolean) => Promise<void>;
  backupProgress: BackupProgress;
  lastBackupAt: string | null;
  triggerBackupNow: () => Promise<void>;
  // Legacy alias for components that used the old API
  isBackupEnabled: boolean;
  toggleBackup: () => Promise<void>;
}

const EMPTY_PROGRESS: BackupProgress = {
  total: 0,
  completed: 0,
  inProgress: 0,
  pending: 0,
  failed: 0,
  state: 'complete',
  reason: 'Nothing to back up',
};

export const BackupContext = createContext<BackupContextValue>({
  isPhotoBackupEnabled: false,
  isContactsBackupEnabled: false,
  isCalendarBackupEnabled: false,
  togglePhotoBackup: async () => {},
  toggleContactsBackup: async () => {},
  toggleCalendarBackup: async () => {},
  includeVideos: true,
  wifiOnly: false,
  backgroundUpload: true,
  setIncludeVideos: async () => {},
  setWifiOnly: async () => {},
  setBackgroundUpload: async () => {},
  backupProgress: EMPTY_PROGRESS,
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
  const { isUnlocked } = useCrypto();
  const [isPhotoBackupEnabled, setIsPhotoBackupEnabled] = useState(false);
  const [isContactsBackupEnabled, setIsContactsBackupEnabled] = useState(false);
  const [isCalendarBackupEnabled, setIsCalendarBackupEnabled] = useState(false);
  const [includeVideos, setIncludeVideosState] = useState(true);
  const [wifiOnly, setWifiOnlyState] = useState(false);
  const [backgroundUpload, setBackgroundUploadState] = useState(true);
  const [backupProgress, setBackupProgress] = useState<BackupProgress>(EMPTY_PROGRESS);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyNativeProgress = useCallback((p: NativeBackupProgress) => {
    const pending = p.pending ?? Math.max(0, p.total - p.completed - p.inProgress);
    const nativeState = p.state ?? (p.inProgress > 0 ? 'uploading' : pending > 0 ? 'idle' : 'complete');
    setBackupProgress({
      total: p.total,
      completed: p.completed,
      inProgress: p.inProgress,
      pending,
      waitingToEncrypt: p.waitingToEncrypt,
      encryptedPendingUpload: p.encryptedPendingUpload,
      uploading: p.uploading,
      failed: p.failed ?? 0,
      state: nativeState,
      reason: p.reason ?? '',
    });
    if (p.lastBackupAt) setLastBackupAt(p.lastBackupAt);
  }, []);

  const refreshNativeProgress = useCallback(async () => {
    if (Platform.OS === 'web') return;
    const p: NativeBackupProgress = await getBackupProgress();
    applyNativeProgress(p);
  }, [applyNativeProgress]);

  const enableNativeBackup = useCallback(async (category: BackupCategory, options: { runNow?: boolean } = {}) => {
    if (Platform.OS === 'web') return;
    const token = await getStoredToken();
    if (!token) return;
    if (!isUnlocked) {
      recordRuntimeTrace('backup.native.enable.deferred', {
        category,
        reason: 'vault_locked',
        runNow: options.runNow !== false,
      });
      return;
    }

    const { categoryFolderId } = await ensureBackupFolders(category);
    await configureBackupFolder(category, categoryFolderId);
    recordRuntimeTrace('backup.native.folder_configured', {
      category,
      hasParentFolder: categoryFolderId.length > 0,
      runNow: options.runNow !== false,
    });

    if (category === 'camera_roll') {
      await enablePhotoBackup(token);
    } else if (category === 'contacts') {
      if (options.runNow === false) {
        await resumeContactsBackup(token);
      } else {
        await enableContactsBackup(token);
      }
    } else {
      if (options.runNow === false) {
        await resumeCalendarBackup(token);
      } else {
        await enableCalendarBackup(token);
      }
    }
  }, [isUnlocked]);

  // Load persisted preferences on mount
  useEffect(() => {
    (async () => {
      try {
        const [photo, contacts, calendar, videos, wifi, bgUpload] = await Promise.all([
          SecureStore.getItemAsync(BACKUP_PHOTO_KEY),
          SecureStore.getItemAsync(BACKUP_CONTACTS_KEY),
          SecureStore.getItemAsync(BACKUP_CALENDAR_KEY),
          SecureStore.getItemAsync(BACKUP_INCLUDE_VIDEOS_KEY),
          SecureStore.getItemAsync(BACKUP_WIFI_ONLY_KEY),
          SecureStore.getItemAsync(BACKUP_BG_UPLOAD_KEY),
        ]);
        setIsPhotoBackupEnabled(photo === 'true');
        setIsContactsBackupEnabled(contacts === 'true');
        setIsCalendarBackupEnabled(calendar === 'true');
        // Defaults: videos on, wifi-only off, background on
        if (videos !== null) setIncludeVideosState(videos === 'true');
        if (wifi !== null) setWifiOnlyState(wifi === 'true');
        if (bgUpload !== null) setBackgroundUploadState(bgUpload === 'true');
        // 0811 — sequence the enables. Firing all three unawaited made each
        // category's ensureBackupFolders race to create its own "Backups" root
        // (duplicate roots). Running them in series means the first warms the
        // folder tree and the rest reuse it; ensureFolder's in-flight coalescing
        // is the belt-and-braces guard for any remaining concurrency (e.g. a
        // background task firing alongside this). Wrapped so the mount effect
        // isn't blocked.
        void (async () => {
          try {
            if (photo === 'true') await enableNativeBackup('camera_roll', { runNow: false });
            if (contacts === 'true') await enableNativeBackup('contacts', { runNow: false });
            if (calendar === 'true') await enableNativeBackup('calendar', { runNow: false });
          } catch {
            // Best-effort warm-up — individual enables log their own failures.
          }
        })();
      } catch {
        // SecureStore unavailable (web / unit tests)
      }
    })();
  }, [enableNativeBackup]);

  // Poll native backup progress every 5 s when photo backup is enabled
  useEffect(() => {
    if (!isPhotoBackupEnabled || Platform.OS === 'web') return;

    const poll = async () => {
      try {
        await refreshNativeProgress();
      } catch {
        // Native module not linked yet — ignore
      }
    };

    poll();
    pollRef.current = setInterval(poll, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isPhotoBackupEnabled, refreshNativeProgress]);

  // Native state can legitimately say "open Beebeeb" after a background handoff.
  // If the user has already foregrounded the app, refresh immediately so Settings
  // reflects the live worker state instead of a stale background state.
  useEffect(() => {
    if (!isPhotoBackupEnabled || Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refreshNativeProgress().catch(() => {});
    });
    return () => sub.remove();
  }, [isPhotoBackupEnabled, refreshNativeProgress]);

  const togglePhotoBackup = useCallback(async () => {
    const next = !isPhotoBackupEnabled;
    setIsPhotoBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_PHOTO_KEY, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          await enableNativeBackup('camera_roll');
          await refreshNativeProgress().catch(() => {});
        } else {
          await disablePhotoBackup();
          await configureBackupFolder('camera_roll', null);
          setBackupProgress(EMPTY_PROGRESS);
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isPhotoBackupEnabled, refreshNativeProgress]);

  const toggleContactsBackup = useCallback(async () => {
    const next = !isContactsBackupEnabled;
    setIsContactsBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_CONTACTS_KEY, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          await enableNativeBackup('contacts');
        } else {
          await disableContactsBackup();
          await configureBackupFolder('contacts', null);
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isContactsBackupEnabled]);

  const toggleCalendarBackup = useCallback(async () => {
    const next = !isCalendarBackupEnabled;
    setIsCalendarBackupEnabled(next);
    try {
      await SecureStore.setItemAsync(BACKUP_CALENDAR_KEY, next ? 'true' : 'false');
      if (Platform.OS !== 'web') {
        if (next) {
          await enableNativeBackup('calendar');
        } else {
          await disableCalendarBackup();
          await configureBackupFolder('calendar', null);
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isCalendarBackupEnabled]);

  const setIncludeVideos = useCallback(async (value: boolean) => {
    setIncludeVideosState(value);
    try {
      await SecureStore.setItemAsync(BACKUP_INCLUDE_VIDEOS_KEY, value ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
  }, []);

  const setWifiOnly = useCallback(async (value: boolean) => {
    setWifiOnlyState(value);
    try {
      await SecureStore.setItemAsync(BACKUP_WIFI_ONLY_KEY, value ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
  }, []);

  const setBackgroundUpload = useCallback(async (value: boolean) => {
    setBackgroundUploadState(value);
    try {
      await SecureStore.setItemAsync(BACKUP_BG_UPLOAD_KEY, value ? 'true' : 'false');
    } catch {
      // SecureStore unavailable
    }
  }, []);

  const triggerBackupNow = useCallback(async () => {
    try {
      // wifiOnly opt-in: refuse to start a manual backup over cellular or
      // when offline.
      if (wifiOnly) {
        const net = await NetInfo.fetch();
        const onWifi = net.type === 'wifi' && net.isConnected !== false;
        if (!onWifi) {
          console.warn('[backup] triggerBackupNow blocked: wifiOnly=true and not on Wi-Fi');
          return;
        }
      }

      if (Platform.OS === 'web') {
        return;
      }

      const token = await getStoredToken();
      if (!token) return;
      try {
        const { categoryFolderId } = await ensureBackupFolders('camera_roll');
        await configureBackupFolder('camera_roll', categoryFolderId);
        const progress = await triggerImmediateBackup(token);
        applyNativeProgress(progress);
      } catch (err) {
        console.warn('[backup] native photo backup warm-up failed:', err);
        await enablePhotoBackup(token);
        await refreshNativeProgress().catch(() => {});
      }
    } catch (err) {
      console.warn('[backup] triggerBackupNow failed:', err);
    }
  }, [applyNativeProgress, refreshNativeProgress, wifiOnly]);

  const value: BackupContextValue = {
    isPhotoBackupEnabled,
    isContactsBackupEnabled,
    isCalendarBackupEnabled,
    togglePhotoBackup,
    toggleContactsBackup,
    toggleCalendarBackup,
    includeVideos,
    wifiOnly,
    backgroundUpload,
    setIncludeVideos,
    setWifiOnly,
    setBackgroundUpload,
    backupProgress,
    lastBackupAt,
    triggerBackupNow,
    // Legacy alias
    isBackupEnabled: isPhotoBackupEnabled,
    toggleBackup: togglePhotoBackup,
  };

  return (
    <BackupContext.Provider value={value}>
      {children}
    </BackupContext.Provider>
  );
}

export function useBackup(): BackupContextValue {
  return useContext(BackupContext);
}
