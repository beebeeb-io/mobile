// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 round 3 (#141 Codex P1 "Drain all plaintext writers before the
 * final cache sweep") — SharedViewScreen's download → decrypt → write never
 * writes the shared_* plaintext after a sign-out purge.
 * Mutation evidence: task 1593 Notes (round 3).
 */
import { describe, expect, test } from 'bun:test';
import { createPlaintextGate, isPlaintextGateClosed } from './plaintext-gate';
import { decryptSharedFileToCache } from './shared-view-decrypt';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function harness(drainTimeoutMs = 5_000) {
  const disk = new Map();
  const gate = createPlaintextGate({ drainTimeoutMs });
  const download = deferred();
  const decrypt = deferred();
  const deps = {
    download: () => download.promise,
    resolveFileKey: async () => new Uint8Array(32),
    resolveName: async () => ({ name: 'Secret.pdf', mimeType: 'application/pdf' }),
    decryptBytes: () => decrypt.promise,
    inferChunkCount: () => 1,
    cacheUri: () => 'file:///cache/shared_tok_Secret.pdf',
    toBase64: () => 'UExBSU5URVhU',
    fs: {
      deleteAsync: async (uri) => { disk.delete(uri); },
      writeBase64: async (uri, b64) => { disk.set(uri, b64); },
    },
    gate,
  };
  const blob = { encryptedBytes: new Uint8Array(100), chunkCount: 1, chunkSize: null, originalSize: 72 };
  // The sweep the purge runs: delete every shared_* file.
  const sweep = async () => { for (const k of [...disk.keys()]) if (k.includes('shared_')) disk.delete(k); };
  return { disk, gate, deps, download, decrypt, blob, sweep };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('decryptSharedFileToCache under the plaintext gate', () => {
  test('no purge: writes the decrypted file and returns its uri + name', async () => {
    const h = harness();
    const p = decryptSharedFileToCache({ size_bytes: 72 }, h.deps);
    h.download.resolve(h.blob);
    h.decrypt.resolve(new Uint8Array(72));
    const r = await p;
    expect(r.uri).toBe('file:///cache/shared_tok_Secret.pdf');
    expect(h.disk.has(r.uri)).toBe(true);
  });

  test('a sign-out purge while the DECRYPT is running: the purge waits, and the file is never written', async () => {
    const h = harness();
    const p = decryptSharedFileToCache({ size_bytes: 72 }, h.deps).catch((e) => e);
    h.download.resolve(h.blob);
    await tick();
    let swept = false;
    const purge = h.gate.purge(async () => { await h.sweep(); swept = true; });
    await tick();
    expect(swept).toBe(false); // drained first
    h.decrypt.resolve(new Uint8Array(72)); // decrypt finishes AFTER the purge began
    await purge;
    expect(isPlaintextGateClosed(await p)).toBe(true);
    expect(h.disk.size).toBe(0);
  });

  test('the SharedView decrypt finishing AFTER the purge returned (past the drain bound) writes nothing', async () => {
    const h = harness(20);
    const p = decryptSharedFileToCache({ size_bytes: 72 }, h.deps).catch((e) => e);
    await tick();
    await h.gate.purge(h.sweep); // returns after the 20 ms bound; download still pending
    h.download.resolve(h.blob);
    h.decrypt.resolve(new Uint8Array(72));
    expect(isPlaintextGateClosed(await p)).toBe(true);
    for (let i = 0; i < 5; i++) await tick();
    expect(h.disk.size).toBe(0);
  });

  test('a decrypt started after the purge (before a new session) is refused outright', async () => {
    const h = harness();
    await h.gate.purge(h.sweep);
    let downloaded = false;
    h.deps.download = async () => { downloaded = true; return h.blob; };
    const err = await decryptSharedFileToCache({ size_bytes: 72 }, h.deps).catch((e) => e);
    expect(isPlaintextGateClosed(err)).toBe(true);
    expect(downloaded).toBe(false);
  });
});
