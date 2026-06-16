/**
 * useOfflineVersion — subscribes a component to the offline manager via
 * `useSyncExternalStore`. The returned value is an opaque version counter that
 * changes on every offline-state mutation; read the actual per-file/folder
 * status from `offlineManager.getStatus(id)` / `.aggregate(ids)` after this.
 */

import { useSyncExternalStore } from 'react';
import { offlineManager } from './offline-manager';

export function useOfflineVersion(): number {
  return useSyncExternalStore(
    offlineManager.subscribe,
    offlineManager.getVersion,
    offlineManager.getVersion,
  );
}
