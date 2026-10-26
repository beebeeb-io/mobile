// @ts-nocheck -- Bun runtime types follow the repo isolated-test convention.
import { beforeEach, expect, mock, test } from 'bun:test';
const uploads: string[] = [];
const localAssets = new Set<string>();
let succeed = true;
mock.module('./thumbnail', () => ({
  isThumbnailable: (mime: string | null) => !!mime && /^(image|video)\//.test(mime),
  THUMBNAIL_REPAIR_RETRY_MS: 60_000,
  generateAndUploadThumbnail: async (id: string) => { uploads.push(id); return succeed; },
}));
mock.module('./local-identifier-map', () => ({ getLocalIdentifier: (id: string) => localAssets.has(id) ? 'photo-kit-id' : null }));
const { maybeSelfRepairThumbnailFromLocalFile: repair, resetThumbnailSelfRepairState: reset } = await import('./thumbnail-self-repair');
const args = (extra = {}) => ({ fileId: 'photo', localPlaintextUri: 'file:///already-decrypted.jpg', mimeType: 'image/jpeg', hasServerThumbnail: true, serverThumbnailBytes: 10_000, getFileKeyBytes: async () => new Uint8Array(32), ...extra });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { reset(); uploads.length = 0; localAssets.clear(); succeed = true; });
test('known degraded thumbnail upgrades once per session and concurrent opens coalesce', async () => {
  repair(args()); repair(args()); await settle(); repair(args()); await settle();
  expect(uploads).toEqual(['photo']);
});
test.each([30 * 1024, 60 * 1024, undefined, null, -1, NaN, Infinity])('healthy or unknown/invalid size %p never triggers repair', async bytes => {
  repair(args({ serverThumbnailBytes: bytes })); await settle(); expect(uploads).toEqual([]);
});
test('explicit missing thumbnail still repairs without a byte count', async () => {
  repair(args({ hasServerThumbnail: false, serverThumbnailBytes: undefined })); await settle(); expect(uploads).toEqual(['photo']);
});
test('unknown thumbnail presence never triggers a probe', async () => {
  repair(args({ hasServerThumbnail: undefined })); await settle(); expect(uploads).toEqual([]);
});
test('PhotoKit, request keys and documents retain their own thumbnail ownership', async () => {
  localAssets.add('local');
  repair(args({ fileId: 'local' })); repair(args({ fileId: 'request', isRequestUpload: true })); repair(args({ fileId: 'doc', mimeType: 'application/pdf' }));
  await settle(); expect(uploads).toEqual([]);
});
test('failed generation remains quiet and backs off instead of looping', async () => {
  succeed = false; repair(args()); await settle(); repair(args()); await settle(); expect(uploads).toEqual(['photo']);
});
