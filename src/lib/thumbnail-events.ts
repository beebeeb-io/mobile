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
