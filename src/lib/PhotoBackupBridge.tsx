/**
 * PhotoBackupBridge — render-less component that connects CryptoContext
 * and BackupContext to the JS-side photo backup runner.
 *
 * Mount once inside both <CryptoProvider> and <BackupProvider>, with the
 * authenticated user in context. On each foreground transition:
 *   - checks photo backup is enabled
 *   - applies Wi-Fi gate if configured
 *   - runs up to 50 photo uploads
 *   - reports live progress back to BackupContext
 *
 * This lives in its own file to keep App.tsx clean and to avoid
 * importing CryptoContext inside BackupContext (circular dep risk).
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useCrypto } from './crypto-context';
import { useBackup } from './backup-context';
import { runPhotoBackupSession, isOnWifi } from '../services/PhotoBackupRunner';

export function PhotoBackupBridge(): null {
  const { isUnlocked, encryptChunk, encryptMetadata } = useCrypto();
  const { isPhotoBackupEnabled, includeVideos, wifiOnly } = useBackup();

  // Track whether a session is already running — avoid double-trigger
  const runningRef = useRef(false);
  // AbortController for the active session
  const abortRef = useRef<AbortController | null>(null);

  // Exposed via ref so the AppState handler has the latest values without
  // needing to re-register the listener on every render
  const stateRef = useRef({
    isUnlocked,
    isPhotoBackupEnabled,
    includeVideos,
    wifiOnly,
    encryptChunk,
    encryptMetadata,
  });
  useEffect(() => {
    stateRef.current = {
      isUnlocked,
      isPhotoBackupEnabled,
      includeVideos,
      wifiOnly,
      encryptChunk,
      encryptMetadata,
    };
  });

  useEffect(() => {
    const appStateRef = { current: AppState.currentState };

    async function maybeStartSession() {
      const s = stateRef.current;
      if (!s.isUnlocked || !s.isPhotoBackupEnabled) return;
      if (runningRef.current) return; // already running

      // Wi-Fi gate
      if (s.wifiOnly) {
        const onWifi = await isOnWifi();
        if (!onWifi) {
          console.log('[PhotoBackupBridge] wifiOnly=true and not on Wi-Fi — skipping session');
          return;
        }
      }

      runningRef.current = true;
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      console.log('[PhotoBackupBridge] starting foreground photo backup session');
      try {
        const result = await runPhotoBackupSession({
          encryptChunkFn: s.encryptChunk,
          encryptMetadataFn: s.encryptMetadata,
          includeVideos: s.includeVideos,
          signal: ctrl.signal,
          onProgress: (uploaded, total) => {
            console.log(`[PhotoBackupBridge] ${uploaded}/${total} photos backed up`);
          },
        });
        console.log('[PhotoBackupBridge] session complete:', result);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.warn('[PhotoBackupBridge] session error:', err);
        }
      } finally {
        runningRef.current = false;
        abortRef.current = null;
      }
    }

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

    // Also trigger once on mount (handles the first launch after login)
    void maybeStartSession();

    return () => {
      subscription.remove();
      // Abort any running session when the component unmounts
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — stateRef stays current via the sync effect above

  return null;
}
