/**
 * Android-only thumbnail repair worker.
 *
 * On iOS the native ThumbnailService actor (BeebeebThumbnails) handles all
 * thumbnail work. On Android we still use the JS-side ThumbnailRepairWorker.
 * This module exports it under an Android-specific name so App.tsx can import
 * it without a platform-guard at the call site.
 */
export { ThumbnailRepairWorker as default } from './ThumbnailRepairWorker';
