/**
 * PhotoBackupBridge — render-less component that connects CryptoContext,
 * BackupContext, and the JS-side photo backup runner.
 *
 * Triggers a backup session:
 *   - On mount (first launch after login)
 *   - On every background → active transition (foreground resume)
 *   - Whenever BackupContext.photoBackupForceCount increments
 *     (triggered by "Back up now" and the manual retry button)
 *
 * Each session:
 *   1. Reads the last checkpoint timestamp from SecureStore
 *   2. Passes it to runPhotoBackupSession so only new photos are processed
 *   3. Writes per-photo checkpoints as each upload succeeds
 *   4. Reports live progress to BackupContext
 *   5. Writes the last-session timestamp on completion
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useCrypto } from './crypto-context';
import { useBackup } from './backup-context';
import {
  runPhotoBackupSession,
  isOnWifi,
} from '../services/PhotoBackupRunner';
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

  // Guard against concurrent sessions
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Keep a stable ref to all the values the session needs, so the AppState
  // handler (registered once) always reads the latest without re-registering.
  const stateRef = useRef({
    isUnlocked,
    isPhotoBackupEnabled,
    includeVideos,
    wifiOnly,
    encryptChunk,
    encryptMetadata,
    reportPhotoProgress,
  });
  // Sync ref on every render — no re-registration needed
  useEffect(() => {
    stateRef.current = {
      isUnlocked,
      isPhotoBackupEnabled,
      includeVideos,
      wifiOnly,
      encryptChunk,
      encryptMetadata,
      reportPhotoProgress,
    };
  });

  const maybeStartSession = useCallback(async () => {
    const s = stateRef.current;
    if (!s.isUnlocked || !s.isPhotoBackupEnabled) return;
    if (runningRef.current) {
      console.log('[PhotoBackupBridge] session already running — skipping trigger');
      return;
    }

    // Wi-Fi gate
    if (s.wifiOnly) {
      const onWifi = await isOnWifi();
      if (!onWifi) {
        console.log('[PhotoBackupBridge] wifiOnly=true and not on Wi-Fi — deferring session');
        return;
      }
    }

    runningRef.current = true;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // Read checkpoint before starting — only process newer assets
    const createdAfterTs = await readLastBackedUpTimestamp();
    console.log('[PhotoBackupBridge] starting session, checkpoint:', createdAfterTs);

    // Mark session as running in context
    s.reportPhotoProgress(0, 0, 0, true);

    let uploadedThisSession = 0;
    let failedThisSession = 0;

    try {
      const result = await runPhotoBackupSession({
        encryptChunkFn: s.encryptChunk,
        encryptMetadataFn: s.encryptMetadata,
        includeVideos: s.includeVideos,
        createdAfterTs,
        signal: ctrl.signal,

        onProgress: (uploaded, total) => {
          uploadedThisSession = uploaded;
          // Report live progress to the context so Settings screen updates
          stateRef.current.reportPhotoProgress(uploaded, total, failedThisSession, true);
        },

        onCheckpoint: (creationTimeSecs) => {
          // Per-photo checkpoint — fire-and-forget, don't block the upload loop
          void writeLastBackedUpTimestamp(creationTimeSecs);
        },
      });

      uploadedThisSession = result.uploaded;
      failedThisSession = result.failed;

      console.log(
        `[PhotoBackupBridge] session complete: ${result.uploaded} uploaded, ` +
        `${result.failed} failed, ${result.remaining} remaining`,
      );

      // Write last-session timestamp for the Settings "Last: X ago" display
      await writeLastSessionAt(new Date().toISOString());
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[PhotoBackupBridge] session error:', err);
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      // Report final state — running: false
      stateRef.current.reportPhotoProgress(
        uploadedThisSession, uploadedThisSession + failedThisSession,
        failedThisSession, false,
      );
    }
  }, []); // stable — reads from stateRef

  // ── AppState: trigger on every foreground transition ────────────────────
  useEffect(() => {
    const appStateRef = { current: AppState.currentState };

    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        const prev = appStateRef.current;
        appStateRef.current = nextState;
        if (
          (prev === 'background' || prev === 'inactive') &&
          nextState === 'active'
        ) {
          void maybeStartSession();
        }
      },
    );

    // Trigger on mount (first foreground after login)
    void maybeStartSession();

    return () => {
      subscription.remove();
      abortRef.current?.abort();
    };
  }, [maybeStartSession]);

  // ── Force trigger: "Back up now" / retry button ──────────────────────────
  useEffect(() => {
    if (photoBackupForceCount > 0) {
      void maybeStartSession();
    }
  }, [photoBackupForceCount, maybeStartSession]);

  return null;
}
