/**
 * PhotoBackupBridge — render-less component that connects CryptoContext,
 * BackupContext state, optional ToastContext, and the PhotoSyncEngine.
 *
 * Must be mounted inside <CryptoProvider> and <BackupProvider>.
 *
 * Lifecycle:
 *   - On mount (backup enabled): startEventListener() + check needsFullScan()
 *     → run fullReconciliation if needed, else processUploads
 *   - On app foreground: processUploads() to drain pending work
 *   - On "Back up now" / retry: fullReconciliation()
 *   - On unmount / disabled: stopEventListener()
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useCrypto } from './crypto-context';
import type { BackupContextValue } from './backup-context';
import { useToast } from './toast-context';
import {
  startEventListener,
  stopEventListener,
  processUploads,
  fullReconciliation,
  needsFullScan,
  type SyncEngineCallbacks,
} from '../services/PhotoSyncEngine';
import { encryptedUpload, generateFileId } from './encrypted-upload';
import { deleteFile } from './api';
import { ensureBackupFolders, getDeletionBehavior, updateBackupCategoryState } from '../services/BackupService';
import { generateAndUploadThumbnail } from './thumbnail';
import { detectMediaMimeType } from './media';
import { getStatusCounts } from '../services/BackupDatabase';
import type { UploadProgress } from './api';

interface PhotoBackupBridgeProps {
  backup: Pick<
    BackupContextValue,
    | 'isPhotoBackupEnabled'
    | 'includeVideos'
    | 'wifiOnly'
    | 'backgroundUpload'
    | 'photoBackupForceCount'
    | 'reportPhotoProgress'
  >;
}

export function PhotoBackupBridge({ backup }: PhotoBackupBridgeProps): null {
  const { isUnlocked, encryptChunk, encryptMetadata, getFileKeyBytes } = useCrypto();
  const {
    isPhotoBackupEnabled,
    includeVideos,
    wifiOnly,
    backgroundUpload,
    photoBackupForceCount,
    reportPhotoProgress,
  } = backup;
  const { showToast } = useToast();

  const abortRef = useRef<AbortController | null>(null);
  const listenerActiveRef = useRef(false);

  // Stable ref: always reflects current render's values without re-registering effects
  const stateRef = useRef({
    isUnlocked,
    isPhotoBackupEnabled,
    includeVideos,
    wifiOnly,
    backgroundUpload,
    encryptChunk,
    encryptMetadata,
    getFileKeyBytes,
    reportPhotoProgress,
    showToast,
  });
  useEffect(() => {
    stateRef.current = {
      isUnlocked,
      isPhotoBackupEnabled,
      includeVideos,
      wifiOnly,
      backgroundUpload,
      encryptChunk,
      encryptMetadata,
      getFileKeyBytes,
      reportPhotoProgress,
      showToast,
    };
  });

  // ── Build SyncEngineCallbacks from current crypto context ─────────────────

  const buildCallbacks = useCallback((): SyncEngineCallbacks => {
    const s = stateRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    return {
      encryptAndUpload: async (asset) => {
        const cameraRollFolderId = await ensureBackupFolders('camera_roll')
          .then((f) => f.categoryFolderId);

        const uri = (asset as any).localUri ?? asset.uri;
        if (!uri || !uri.startsWith('file://')) {
          throw new Error(`No local URI for ${asset.filename}`);
        }

        const fileId = generateFileId();

        const uploaded = await encryptedUpload({
          fileId,
          uri,
          name: asset.filename,
          parentId: cameraRollFolderId,
          mimeType: detectMediaMimeType(asset.filename, asset.mediaType),
          encryptChunkFn: s.encryptChunk,
          encryptMetadataFn: s.encryptMetadata,
          onProgress: (_p: UploadProgress) => {
            // Progress is reported via onProgress callback on the engine level
          },
        });

        // Fire-and-forget thumbnail generation
        void generateAndUploadThumbnail(
          uploaded.id,
          uri,
          detectMediaMimeType(asset.filename, asset.mediaType),
          s.getFileKeyBytes,
        );

        return { fileId: uploaded.id };
      },

      deleteServerFile: async (fileId: string) => {
        await deleteFile(fileId);
      },

      getDeletionBehavior: () => {
        // getDeletionBehavior is async but the callback is sync — we use 'keep'
        // as the default and the full reconciliation will read the real value.
        // The event listener calls this synchronously, so we cache it.
        // For real-time events, 'keep' is the safe default.
        return 'keep';
      },

      onProgress: (counts) => {
        const uploaded = (counts.uploaded ?? 0) + (counts.orphaned ?? 0);
        const pending = (counts.pending_upload ?? 0) + (counts.pending_reupload ?? 0);
        const failed = counts.failed ?? 0;
        const total = uploaded + pending + failed + (counts.uploading ?? 0);
        const isRunning = pending > 0 || (counts.uploading ?? 0) > 0;
        stateRef.current.reportPhotoProgress(
          uploaded, total, failed, isRunning, 0, null,
        );
      },

      signal: ctrl.signal,
    };
  }, []);

  // ── Build callbacks with async deletion behavior for reconciliation ───────

  const buildCallbacksWithDeletion = useCallback(async (): Promise<SyncEngineCallbacks> => {
    const base = buildCallbacks();
    const behavior = await getDeletionBehavior();
    return {
      ...base,
      getDeletionBehavior: () => behavior,
    };
  }, [buildCallbacks]);

  // ── Start the sync engine ─────────────────────────────────────────────────

  const startSync = useCallback(async () => {
    const s = stateRef.current;
    if (!s.isUnlocked || !s.isPhotoBackupEnabled) return;

    // Wi-Fi check for wifiOnly users
    if (s.wifiOnly) {
      try {
        const net = await NetInfo.fetch();
        const onWifi = net.type === 'wifi' && net.isConnected !== false;
        if (!onWifi) {
          console.log('[PhotoBackupBridge] wifiOnly=true and not on Wi-Fi — deferring');
          return;
        }
      } catch {
        // If we can't check, proceed anyway
      }
    }

    // Start event listener if not already active
    if (!listenerActiveRef.current) {
      const callbacks = await buildCallbacksWithDeletion();
      startEventListener(callbacks);
      listenerActiveRef.current = true;
      console.log('[PhotoBackupBridge] event listener started');
    }

    // Check if we need a full scan
    const shouldFullScan = await needsFullScan();
    if (shouldFullScan) {
      console.log('[PhotoBackupBridge] full scan needed — running reconciliation');
      stateRef.current.reportPhotoProgress(0, 0, 0, true, 0, null);

      try {
        const callbacks = await buildCallbacksWithDeletion();
        await fullReconciliation(callbacks);
        const counts = await getStatusCounts();
        const uploaded = (counts.uploaded ?? 0) + (counts.orphaned ?? 0);
        const failed = counts.failed ?? 0;

        if (uploaded > 0) {
          stateRef.current.showToast({
            type: 'success',
            message: `Backup sync complete — ${uploaded} files synced`,
          });
        }

        // Update manifest
        await updateBackupCategoryState('camera_roll', {
          enabled: true,
          last_sync: new Date().toISOString(),
          include_videos: stateRef.current.includeVideos,
          wifi_only: stateRef.current.wifiOnly,
          background_enabled: stateRef.current.backgroundUpload,
        }).catch((err) => {
          console.warn('[PhotoBackupBridge] could not update camera-roll manifest:', err);
        });
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.warn('[PhotoBackupBridge] reconciliation error:', err);
        }
      }
    } else {
      // Just drain pending uploads
      try {
        const callbacks = await buildCallbacksWithDeletion();
        const uploadedCount = await processUploads(callbacks);
        if (uploadedCount > 0) {
          const label = uploadedCount === 1 ? '1 photo backed up' : `${uploadedCount} photos backed up`;
          stateRef.current.showToast({ type: 'success', message: label });

          await updateBackupCategoryState('camera_roll', {
            enabled: true,
            last_sync: new Date().toISOString(),
            include_videos: stateRef.current.includeVideos,
            wifi_only: stateRef.current.wifiOnly,
            background_enabled: stateRef.current.backgroundUpload,
          }).catch((err) => {
            console.warn('[PhotoBackupBridge] could not update camera-roll manifest:', err);
          });
        }
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          console.warn('[PhotoBackupBridge] processUploads error:', err);
        }
      }
    }

    // Report final status
    try {
      const counts = await getStatusCounts();
      const uploaded = (counts.uploaded ?? 0) + (counts.orphaned ?? 0);
      const pending = (counts.pending_upload ?? 0) + (counts.pending_reupload ?? 0);
      const failed = counts.failed ?? 0;
      const total = uploaded + pending + failed;
      stateRef.current.reportPhotoProgress(uploaded, total, failed, false, 0, null);
    } catch {
      // Status counts unavailable
    }
  }, [buildCallbacksWithDeletion]);

  // ── Force trigger: "Back up now" / retry button ────────────────────────────

  const triggerFullReconciliation = useCallback(async () => {
    const s = stateRef.current;
    if (!s.isUnlocked || !s.isPhotoBackupEnabled) return;

    console.log('[PhotoBackupBridge] force trigger — running full reconciliation');
    stateRef.current.reportPhotoProgress(0, 0, 0, true, 0, null);

    try {
      const callbacks = await buildCallbacksWithDeletion();
      await fullReconciliation(callbacks);

      const counts = await getStatusCounts();
      const uploaded = (counts.uploaded ?? 0) + (counts.orphaned ?? 0);
      const failed = counts.failed ?? 0;

      if (uploaded > 0) {
        stateRef.current.showToast({
          type: 'success',
          message: `Backup complete — ${uploaded} files synced`,
        });
      } else if (failed > 0) {
        stateRef.current.showToast({
          type: 'error',
          message: `${failed} file${failed !== 1 ? 's' : ''} failed to back up`,
        });
      }

      await updateBackupCategoryState('camera_roll', {
        enabled: true,
        last_sync: new Date().toISOString(),
        include_videos: stateRef.current.includeVideos,
        wifi_only: stateRef.current.wifiOnly,
        background_enabled: stateRef.current.backgroundUpload,
      }).catch((err) => {
        console.warn('[PhotoBackupBridge] could not update camera-roll manifest:', err);
      });
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[PhotoBackupBridge] fullReconciliation error:', err);
        stateRef.current.showToast({
          type: 'error',
          message: 'Backup failed — please try again',
        });
      }
    }

    // Report final status
    try {
      const counts = await getStatusCounts();
      const uploaded = (counts.uploaded ?? 0) + (counts.orphaned ?? 0);
      const pending = (counts.pending_upload ?? 0) + (counts.pending_reupload ?? 0);
      const failed = counts.failed ?? 0;
      const total = uploaded + pending + failed;
      stateRef.current.reportPhotoProgress(uploaded, total, failed, false, 0, null);
    } catch {
      // Status counts unavailable
    }
  }, [buildCallbacksWithDeletion]);

  // ── Mount / backup enable: start listener + initial sync ──────────────────

  useEffect(() => {
    if (isUnlocked && isPhotoBackupEnabled) {
      void startSync();
    }

    return () => {
      // Cleanup on unmount or when backup is disabled
      if (listenerActiveRef.current) {
        stopEventListener();
        listenerActiveRef.current = false;
        console.log('[PhotoBackupBridge] event listener stopped');
      }
      abortRef.current?.abort();
    };
  }, [isUnlocked, isPhotoBackupEnabled, startSync]);

  // ── AppState: trigger on every foreground transition ────────────────────────
  useEffect(() => {
    const appStateRef = { current: AppState.currentState };
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;
      if ((prev === 'background' || prev === 'inactive') && next === 'active') {
        void startSync();
      }
    });
    return () => {
      sub.remove();
    };
  }, [startSync]);

  // ── NetInfo: automatically resume when Wi-Fi reconnects (wifiOnly users) ──
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (
        state.type === 'wifi' &&
        state.isConnected !== false &&
        stateRef.current.wifiOnly
      ) {
        console.log('[PhotoBackupBridge] Wi-Fi reconnected — triggering sync');
        void startSync();
      }
    });
    return unsubscribe;
  }, [startSync]);

  // ── Force trigger: "Back up now" / retry button ────────────────────────────
  useEffect(() => {
    if (photoBackupForceCount > 0) {
      void triggerFullReconciliation();
    }
  }, [photoBackupForceCount, triggerFullReconciliation]);

  return null;
}
