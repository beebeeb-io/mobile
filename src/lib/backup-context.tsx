import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
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
  type NativeBackupProgress,
} from '../../modules/beebeeb-crypto';
import { ensureBackupFolders, type BackupCategory } from '../services/BackupService';
import { PhotoBackupBridge } from './PhotoBackupBridge';

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
}

export interface PhotoSessionProgress {
  running: boolean;
  uploaded: number;
  total: number;
  failed: number;
  throughputBps: number;
  etaSeconds: number | null;
  currentFileName: string;
  currentFileSizeBytes: number;
}

export interface PhotoSessionResult {
  uploaded: number;
  failed: number;
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
  // Photo backup session state kept for legacy UI surfaces.
  /** Live progress of the current foreground backup session. */
  photoSessionProgress: PhotoSessionProgress;
  /** Result of the most recently completed backup session, or null. */
  lastPhotoSession: PhotoSessionResult | null;
  /** Called by backup runners to report live + completed session state. */
  reportPhotoProgress: (
    uploaded: number, total: number, failed: number, running: boolean,
    throughputBps?: number, etaSeconds?: number | null,
    currentFileName?: string, currentFileSizeBytes?: number,
  ) => void;
  /**
   * Legacy compatibility counter for older camera-roll runner surfaces.
   */
  photoBackupForceCount: number;
  // Legacy alias for components that used the old API
  isBackupEnabled: boolean;
  toggleBackup: () => Promise<void>;
}

const EMPTY_SESSION: PhotoSessionProgress = { running: false, uploaded: 0, total: 0, failed: 0, throughputBps: 0, etaSeconds: null, currentFileName: '', currentFileSizeBytes: 0 };

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
  backupProgress: { total: 0, completed: 0, inProgress: 0 },
  lastBackupAt: null,
  triggerBackupNow: async () => {},
  photoSessionProgress: EMPTY_SESSION,
  lastPhotoSession: null,
  reportPhotoProgress: () => {},
  photoBackupForceCount: 0,
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
  const [includeVideos, setIncludeVideosState] = useState(true);
  const [wifiOnly, setWifiOnlyState] = useState(false);
  const [backgroundUpload, setBackgroundUploadState] = useState(true);
  const [backupProgress, setBackupProgress] = useState<BackupProgress>({ total: 0, completed: 0, inProgress: 0 });
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // JS-side photo backup session state
  const [photoSessionProgress, setPhotoSessionProgress] = useState<PhotoSessionProgress>(EMPTY_SESSION);
  const [lastPhotoSession, setLastPhotoSession] = useState<PhotoSessionResult | null>(null);
  const [photoBackupForceCount, setPhotoBackupForceCount] = useState(0);

  const reportPhotoProgress = useCallback((
    uploaded: number, total: number, failed: number, running: boolean,
    throughputBps = 0, etaSeconds: number | null = null,
    currentFileName = '', currentFileSizeBytes = 0,
  ) => {
    setPhotoSessionProgress({ running, uploaded, total, failed, throughputBps, etaSeconds, currentFileName, currentFileSizeBytes });
    if (!running && (uploaded > 0 || failed > 0)) {
      setLastPhotoSession({ uploaded, failed });
    }
  }, []);

  const enableNativeBackup = useCallback(async (category: BackupCategory, options: { runNow?: boolean } = {}) => {
    if (Platform.OS === 'web') return;
    const token = await getStoredToken();
    if (!token) return;

    const { categoryFolderId } = await ensureBackupFolders(category);
    await configureBackupFolder(category, categoryFolderId);

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
  }, []);

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
        if (photo === 'true') void enableNativeBackup('camera_roll', { runNow: false });
        if (contacts === 'true') void enableNativeBackup('contacts', { runNow: false });
        if (calendar === 'true') void enableNativeBackup('calendar', { runNow: false });
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
          await enableNativeBackup('camera_roll');
          setPhotoBackupForceCount((c) => c + 1);
        } else {
          await disablePhotoBackup();
          await configureBackupFolder('camera_roll', null);
          setBackupProgress({ total: 0, completed: 0, inProgress: 0 });
        }
      }
    } catch {
      // Native module not linked yet
    }
  }, [enableNativeBackup, isPhotoBackupEnabled]);

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
        setPhotoBackupForceCount((c) => c + 1);
        return;
      }

      const token = await getStoredToken();
      if (!token) return;
      try {
        const { categoryFolderId } = await ensureBackupFolders('camera_roll');
        await configureBackupFolder('camera_roll', categoryFolderId);
        await enablePhotoBackup(token);
      } catch (err) {
        console.warn('[backup] native photo backup warm-up failed:', err);
      }
      setPhotoBackupForceCount((c) => c + 1);
    } catch (err) {
      console.warn('[backup] triggerBackupNow failed:', err);
    }
  }, [wifiOnly]);

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
    photoSessionProgress,
    lastPhotoSession,
    reportPhotoProgress,
    photoBackupForceCount,
    // Legacy alias
    isBackupEnabled: isPhotoBackupEnabled,
    toggleBackup: togglePhotoBackup,
  };

  return (
    <BackupContext.Provider value={value}>
      {children}
      <PhotoBackupBridge backup={value} />
    </BackupContext.Provider>
  );
}

export function useBackup(): BackupContextValue {
  return useContext(BackupContext);
}
