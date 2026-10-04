// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const STREAMER_SWIFT = readFileSync(
  join(REPO_ROOT, 'modules', 'beebeeb-crypto', 'ios', 'NativeVideoStreamer.swift'),
  'utf8',
);

function bracedBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`signature not found: ${signature}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) throw new Error(`opening brace not found for: ${signature}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`closing brace not found for: ${signature}`);
}

describe('iOS NativeVideoStreamer source contract', () => {
  test('exposes start plus request, stream, and global cancellation hooks for the bridge owner', () => {
    expect(STREAMER_SWIFT).toMatch(/static func start\(/);
    expect(STREAMER_SWIFT).toContain('PlaintextStorageProtection.isPurgePending()');
    expect(STREAMER_SWIFT).toMatch(/static func cancel\(requestId: String\) -> Bool/);
    expect(STREAMER_SWIFT).toMatch(/static func cancel\(streamId: String\) -> Bool/);
    expect(STREAMER_SWIFT).toMatch(/static func cancelAll\(\)/);
  });

  test('uses per-chunk endpoints and existing opaque handle crypto, never a whole-file download', () => {
    expect(STREAMER_SWIFT).toContain('/api/v1/files/\\(fileId)/chunks/\\(index)');
    expect(STREAMER_SWIFT).toContain('master.deriveFileKey(fileId: Data(fileId.utf8))');
    expect(STREAMER_SWIFT).toContain('fileKey!.decryptChunk(nonce: nonce, ciphertext: ciphertext)');
    expect(STREAMER_SWIFT).toContain('URLSession.shared.downloadTask');
    expect(STREAMER_SWIFT).not.toContain('URLSession.shared.dataTask');
    expect(STREAMER_SWIFT).not.toContain('/download');
    expect(STREAMER_SWIFT).not.toContain('decryptFile(');
  });

  test('stream URLs are loopback-only with a random 128-bit capability id', () => {
    expect(STREAMER_SWIFT).toContain('SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)');
    expect(STREAMER_SWIFT).toMatch(/var bytes = \[UInt8\]\(repeating: 0, count: 16\)/);
    expect(STREAMER_SWIFT).toContain('http://127.0.0.1:\\(port)/s/\\(session.streamId)/');
    expect(STREAMER_SWIFT).toContain('parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(loopback), port: .any)');
    const loopbackBody = bracedBody(STREAMER_SWIFT, 'private func isLoopbackEndpoint(_ endpoint: NWEndpoint) -> Bool {');
    expect(loopbackBody).toContain('127.0.0.1');
    expect(loopbackBody).toContain('::1');
    expect(loopbackBody).toContain('localhost');
  });

  test('partial sparse plaintext never uses the final output path and promotes only after all chunks decrypt', () => {
    expect(STREAMER_SWIFT).toContain('decrypted.streaming');
    expect(STREAMER_SWIFT).toContain('try FileManager.default.moveItem(at: partialPlainUrl, to: outputUrl)');
    const decryptBody = bracedBody(STREAMER_SWIFT, 'private func decryptChunkFromDisk(index: Int) throws -> Bool {');
    expect(decryptBody).toContain('if done >= count');
    expect(decryptBody).toContain('try finalizeSuccess()');
  });

  test('cancel all tears down active sessions and removes partial plaintext', () => {
    const registryBody = bracedBody(STREAMER_SWIFT, 'private final class NativeVideoStreamRegistry: @unchecked Sendable {');
    const cancelAll = bracedBody(registryBody, 'func cancelAll() {');
    expect(cancelAll).toContain('sessions.forEach { $0.cancel() }');
    const sessionBody = bracedBody(STREAMER_SWIFT, 'private final class NativeVideoStreamSession: @unchecked Sendable {');
    const cancel = bracedBody(sessionBody, 'func cancel() {');
    expect(cancel).toContain('fetchQueue.cancelAllOperations()');
    expect(cancel).toContain('decryptQueue.cancelAllOperations()');
    expect(cancel).toContain('teardown(deletePartial: true, unregister: true)');
  });

  test('range handling rejects malformed or unsatisfiable ranges with 416', () => {
    const serveGet = bracedBody(STREAMER_SWIFT, 'private func serveGet(connection: NWConnection, session: NativeVideoStreamSession, rangeHeader: String?) {');
    expect(serveGet).toContain('respondError(connection: connection, status: 416');
    const resolve = bracedBody(STREAMER_SWIFT, 'private func resolveRange(_ header: String?, total: Int64) -> (start: Int64, end: Int64)? {');
    expect(resolve).toContain('guard let parsedEnd = Int64(endRaw) else { return nil }');
    expect(resolve).toContain('guard start >= 0, start <= end, start < total else { return nil }');
  });

  test('read-ahead and progress accounting stay bounded for large chunk counts', () => {
    expect(STREAMER_SWIFT).not.toContain('for index in 0..<chunkCount {\n      total += NativeVideoChunkMath.encryptedSize');
    expect(STREAMER_SWIFT).toContain('for index in order where !self.ensureChunk(index).wait() || self.stopRequested()');
  });
});
