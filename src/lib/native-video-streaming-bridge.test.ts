// @ts-nocheck — native bridge wiring; native behavior is exercised in Swift.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const source = readFileSync(join(import.meta.dir, '../../modules/beebeeb-crypto/ios/BeebeebCryptoModule.swift'), 'utf8');
function between(start: string, end: string): string {
  const index = source.indexOf(start);
  expect(index).toBeGreaterThanOrEqual(0);
  const next = source.indexOf(end, index + start.length);
  expect(next).toBeGreaterThan(index);
  return source.slice(index, next);
}
test('progressive startup requires an owner handle and a clear native purge gate', () => {
  const body = between('AsyncFunction("streamVideoNative")', 'AsyncFunction("cancelVideoStreamNative")');
  expect(body).toContain('params["handleId"] as? NSNumber');
  expect(body).toContain('!PlaintextStorageProtection.isPurgePending()');
  expect(body).toContain('self.getHandle(handleNumber.intValue)');
  expect(body.indexOf('streamStartupCancellations[requestId] = progress')).toBeLessThan(body.indexOf('Task.detached'));
  expect(body).toContain('streamStartupCancellations.removeValue(forKey: requestId)');
});
test('both cancellation surfaces cover a pending or playable stream', () => {
  const body = between('AsyncFunction("cancelDownloadAndDecryptFileNative")', 'Function("getPreviewLoadProgress")');
  expect(body).toContain('startup?.cancel()');
  expect(body).toContain('NativeVideoStreamer.cancel(requestId: requestId)');
  expect(source).toContain('NativeVideoStreamer.cancel(streamId: streamId)');
});
test('purge marks its gate before closing streams and key release closes streams', () => {
  const purge = between('AsyncFunction("purgePlaintextStorage")', 'AsyncFunction("releaseHandle")');
  expect(purge).toContain('self.cancelAllPreviewStreams()');
  expect(purge.indexOf('markPurgePending()')).toBeLessThan(purge.indexOf('self.cancelAllPreviewStreams()'));
  const release = between('AsyncFunction("releaseHandle")', 'AsyncFunction("storeKeyInKeychain")');
  expect(release).toContain('self.cancelAllPreviewStreams()');
  expect(release.indexOf('self.cancelAllPreviewStreams()')).toBeLessThan(release.indexOf('masterKeyHandles.removeValue'));
  const keyDelete = between('AsyncFunction("deleteKeyFromKeychain")', 'AsyncFunction("setRequireBiometric")');
  expect(keyDelete).toContain('self.cancelAllPreviewStreams()');
  expect(keyDelete.indexOf('self.cancelAllPreviewStreams()')).toBeLessThan(keyDelete.indexOf('KeychainManager.delete()'));
});
test('terminal progress is retired only when read by the polling consumer', () => {
  const read = between('private func readPreviewProgress', 'private func storeUploadProgress');
  expect(read).toContain('stage == "complete" || stage == "error"');
  expect(read).toContain('previewProgressSnapshots.removeValue(forKey: requestId)');
  expect(read.indexOf('let snapshot =')).toBeLessThan(read.indexOf('removeValue'));
  expect(read).toContain('return snapshot');
});
