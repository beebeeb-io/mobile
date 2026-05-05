/**
 * PhotoBackupBridge — render-less component that connects CryptoContext,
 * BackupContext, ToastContext, and the JS-side photo backup runner.
 *
 * Must be mounted inside <CryptoProvider>, <BackupProvider>, AND <ToastProvider>.
 *
 * Triggers a backup session on:
 *   1. Mount (first launch after login)
 *   2. Every background → active AppState transition
 *   3. NetInfo: Wi-Fi connection established (for wifiOnly users)
 *   4. photoBackupForceCount change ("Back up now" / retry)
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useCrypto } from './crypto-context';
import { useBackup } from './backup-context';
import { useToast } from './toast-context';
import { runPhotoBackupSession, isOnWifi } from '../services/PhotoBackupRunner';
import {
  readLastBackedUpTimestamp,
  writeLastBackedUpTimestamp,
  writeLastSessionAt,
} from '../services/PhotoBackupCheckpoint';

export function PhotoBackupBridge(): null {
  const { isUnlocked, encryptChunk, encryptMetadata } = useCrypto();
  const {
    isPhotoBackupEnabled,
    includeVideos,
    wifiOnly,
    photoBackupForceCount,
    reportPhotoProgress,
  } = useBackup();
  const { showToast } = useToast();

  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Stable ref: always reflects current render's values without re-registering effects
  const stateRef = useRef({
    isUnlocked,
    isPhotoBackupEnabled,
    includeVideos,
    wifiOnly,
    encryptChunk,
    encryptMetadata,
    reportPhotoProgress,
    showToast,
  });
  useEffect(() => {
    stateRef.current = {
      isUnlocked,
      isPhotoBackupEnabled,
      includeVideos,
      wifiOnly,
      encryptChunk,
      encryptMetadata,
      reportPhotoProgress,
      showToast,
    };
  });

  // ── Core session logic ─────────────────────────────────────────────────────

  const maybeStartSession = useCallback(async () => {
    const s = stateRef.current;
    if (!s.isUnlocked || !s.isPhotoBackupEnabled) return;
    if (runningRef.current) {
      console.log('[PhotoBackupBridge] session already running — skipping trigger');
      return;
    }

    if (s.wifiOnly) {
      const onWifi = await isOnWifi();
      if (!onWifi) {
        console.log('[PhotoBackupBridge] wifiOnly=true and not on Wi-Fi — deferring');
        return;
      }
    }

    runningRef.current = true;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const createdAfterTs = await readLastBackedUpTimestamp();
    console.log('[PhotoBackupBridge] starting session, checkpoint:', createdAfterTs);

    // Mark running
    stateRef.current.reportPhotoProgress(0, 0, 0, true, 0, null);

    let uploadedThisSession = 0;
    let failedThisSession = 0;

    try {
      const result = await runPhotoBackupSession({
        encryptChunkFn: s.encryptChunk,
        encryptMetadataFn: s.encryptMetadata,
        includeVideos: s.includeVideos,
        createdAfterTs,
        signal: ctrl.signal,

        onProgress: ({ uploaded, total, throughputBps, etaSeconds, currentFileName, currentFileSizeBytes }) => {
          uploadedThisSession = uploaded;
          stateRef.current.reportPhotoProgress(
            uploaded, total, failedThisSession, true, throughputBps, etaSeconds,
            currentFileName, currentFileSizeBytes,
          );
        },

        onCheckpoint: (ts) => {
          void writeLastBackedUpTimestamp(ts);
        },
      });

      uploadedThisSession = result.uploaded;
      failedThisSession = result.failed;

      console.log(
        `[PhotoBackupBridge] session done: ${result.uploaded} uploaded, ` +
        `${result.failed} failed, ${result.remaining} remaining`,
      );

      // Toast (only when app is foregrounded — bridge is mounted, so we're active)
      if (result.uploaded > 0) {
        const label = result.uploaded === 1 ? '1 photo backed up' : `${result.uploaded} photos backed up`;
        stateRef.current.showToast({ type: 'success', message: label });
      } else if (result.failed > 0) {
        stateRef.current.showToast({
          type: 'error',
          message: `${result.failed} photo${result.failed !== 1 ? 's' : ''} failed to back up`,
        });
      }

      await writeLastSessionAt(new Date().toISOString());
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[PhotoBackupBridge] session error:', err);
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      stateRef.current.reportPhotoProgress(
        uploadedThisSession,
        uploadedThisSession + failedThisSession,
        failedThisSession,
        false,
        0,
        null,
      );
    }
  }, []); // stable — reads stateRef

  // ── AppState: trigger on every foreground transition ────────────────────────
  useEffect(() => {
    const appStateRef = { current: AppState.currentState };
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if ((prev === 'background' || prev === 'inactive') && next === 'active') {
        void maybeStartSession();
      }
    });
    void maybeStartSession(); // initial mount trigger
    return () => {
      sub.remove();
      abortRef.current?.abort();
    };
  }, [maybeStartSession]);

  // ── NetInfo: automatically resume when Wi-Fi reconnects (wifiOnly users) ──
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (
        state.type === 'wifi' &&
        state.isConnected !== false &&
        stateRef.current.wifiOnly
      ) {
        console.log('[PhotoBackupBridge] Wi-Fi reconnected — triggering session');
        void maybeStartSession();
      }
    });
    return unsubscribe;
  }, [maybeStartSession]);

  // ── Force trigger: "Back up now" / retry button ────────────────────────────
  useEffect(() => {
    if (photoBackupForceCount > 0) {
      void maybeStartSession();
    }
  }, [photoBackupForceCount, maybeStartSession]);

  return null;
}
