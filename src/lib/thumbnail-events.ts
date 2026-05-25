/**
 * Typed wrapper around the native ThumbnailService event emitter.
 *
 * Native side: `ThumbnailServiceModule.swift` declares
 * `Events("onThumbnailReady", "onAssociationCleared")`. The actor fires those
 * via `sendEvent(name, body)`. This module shapes them into a strongly typed
 * observer so callers don't pass stringly-typed names around.
 */

import { NativeModulesProxy, requireOptionalNativeModule } from 'expo-modules-core';

interface ThumbnailReadyEvent {
  fileId: string;
  source: 'photoKit' | 'remote' | 'cache';
  uri: string;
}

interface AssociationClearedEvent {
  fileId: string;
}

type Subscription = { remove: () => void };

const Native = requireOptionalNativeModule<{
  addListener?: (eventName: string, listener: (event: unknown) => void) => Subscription;
}>('ThumbnailService') ?? (NativeModulesProxy as unknown as {
  ThumbnailService?: {
    addListener?: (eventName: string, listener: (event: unknown) => void) => Subscription;
  };
}).ThumbnailService;

function safeAddListener(
  eventName: string,
  listener: (event: unknown) => void,
): Subscription | null {
  if (!Native?.addListener) return null;
  return Native.addListener(eventName, listener);
}

export function onThumbnailReady(
  handler: (event: ThumbnailReadyEvent) => void,
): Subscription {
  const sub = safeAddListener('onThumbnailReady', (raw) => {
    const event = raw as Partial<ThumbnailReadyEvent>;
    if (typeof event?.fileId === 'string' && typeof event?.uri === 'string' && typeof event?.source === 'string') {
      handler(event as ThumbnailReadyEvent);
    }
  });
  return sub ?? { remove: () => {} };
}

export function onAssociationCleared(
  handler: (event: AssociationClearedEvent) => void,
): Subscription {
  const sub = safeAddListener('onAssociationCleared', (raw) => {
    const event = raw as Partial<AssociationClearedEvent>;
    if (typeof event?.fileId === 'string') {
      handler(event as AssociationClearedEvent);
    }
  });
  return sub ?? { remove: () => {} };
}

// ─── Worker pool events ───────────────────────────────────────────────────────

export interface PoolStatsEvent {
  workers: Array<{ slot: number; fileId: string | null; stage: string; elapsedMs: number }>;
  completed: number;
  failed: number;
  retrying: number;
  queueDepth: number;
  filesPerSec: number;
  kbPerSec: number;
  etaSec: number;
  isPaused: boolean;
  isThermalThrottled: boolean;
}

export interface FileCompletedEvent {
  fileId: string;
  success: boolean;
  category: string | null;
  totalMs: number;
  stageBreakdown: Record<string, number>;
}

export interface WorkerFailureEvent {
  fileId: string;
  errorCode: string;
  errorMessage: string;
  attempt: number;
}

export interface WorkerStageEvent {
  slot: number;
  fileId: string;
  stage: string;
  elapsedMs: number;
}

export function onPoolStats(
  handler: (event: PoolStatsEvent) => void,
): Subscription {
  const sub = safeAddListener('onPoolStats', (raw) => {
    handler(raw as PoolStatsEvent);
  });
  return sub ?? { remove: () => {} };
}

export function onFileCompleted(
  handler: (event: FileCompletedEvent) => void,
): Subscription {
  const sub = safeAddListener('onFileCompleted', (raw) => {
    const event = raw as Partial<FileCompletedEvent>;
    if (typeof event?.fileId === 'string') {
      handler(event as FileCompletedEvent);
    }
  });
  return sub ?? { remove: () => {} };
}

export function onWorkerFailure(
  handler: (event: WorkerFailureEvent) => void,
): Subscription {
  const sub = safeAddListener('onWorkerFailure', (raw) => {
    const event = raw as Partial<WorkerFailureEvent>;
    if (typeof event?.fileId === 'string') {
      handler(event as WorkerFailureEvent);
    }
  });
  return sub ?? { remove: () => {} };
}

export function onWorkerStage(
  handler: (event: WorkerStageEvent) => void,
): Subscription {
  const sub = safeAddListener('onWorkerStage', (raw) => {
    const event = raw as Partial<WorkerStageEvent>;
    if (typeof event?.fileId === 'string' && typeof event?.slot === 'number') {
      handler(event as WorkerStageEvent);
    }
  });
  return sub ?? { remove: () => {} };
}
