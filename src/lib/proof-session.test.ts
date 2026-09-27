// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1593 — "Prove it" data flow (#141 security review items 2-5 + the
 * Codex thread on EncryptionProof.tsx:97: never two full transfers).
 * Mutation evidence: task 1593 Notes.
 */
import { describe, expect, test } from 'bun:test';
import { fetchCiphertextPrefix, startProofSession, CLOSED_PLAIN_STATE } from './proof-session';
import { PROOF_BYTES, PROOF_DECRYPT_MAX_BYTES } from './encryption-proof';

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness(overrides = {}) {
  const log = { decrypts: 0, prefixFetches: [] as number[], deletes: [] as string[], plain: [] as any[], cipher: [] as any[], signals: [] as AbortSignal[] };
  const deps = {
    sizeBytes: 10 * 1024 * 1024,
    decrypt: async (signal, onSource) => {
      log.decrypts += 1;
      log.signals.push(signal);
      onSource('decrypted');
      return 'file:///cache/preview/f.jpg';
    },
    readPrefix: async (_path, length) => new Uint8Array(length).fill(0x41),
    releaseCopy: async () => { log.deletes.push('released'); },
    fetchCiphertextPrefix: async (length, signal) => {
      log.prefixFetches.push(length);
      log.signals.push(signal);
      return new Uint8Array(length).fill(0xee);
    },
    onPlain: (s) => log.plain.push(s),
    onCipher: (s) => log.cipher.push(s),
    ...overrides,
  };
  return { deps, log };
}

describe('startProofSession', () => {
  test('one decrypt + one 512-byte ciphertext prefix fetch — never a second full download', async () => {
    const { deps, log } = harness();
    startProofSession(deps);
    await tick();
    expect(log.decrypts).toBe(1);
    expect(log.prefixFetches).toEqual([PROOF_BYTES]);
    expect(log.plain.at(-1).status).toBe('ready');
    expect(log.plain.at(-1).plaintext.length).toBe(PROOF_BYTES);
    expect(log.cipher.at(-1).status).toBe('ready');
    expect(log.cipher.at(-1).bytes.length).toBe(PROOF_BYTES);
  });

  test('gives back (releases) the plaintext copy it decrypted itself after the 512-byte read', async () => {
    const { deps, log } = harness();
    startProofSession(deps);
    await tick();
    expect(log.deletes).toEqual(['released']);
  });

  test('leaves a preview-cache hit (or a shared decrypt) alone', async () => {
    for (const source of ['cache', 'joined']) {
      const { deps, log } = harness({
        decrypt: async (_signal, onSource) => { onSource(source); return 'file:///cache/preview/f.jpg'; },
      });
      startProofSession(deps);
      await tick();
      expect(log.deletes).toEqual([]);
      expect(log.plain.at(-1).status).toBe('ready');
    }
  });

  test('close() aborts the decrypt and the ranged request', async () => {
    const { deps, log } = harness({
      decrypt: (signal) => { log.signals.push(signal); return new Promise(() => {}); },
      fetchCiphertextPrefix: (_len, signal) => { log.signals.push(signal); return new Promise(() => {}); },
    });
    const session = startProofSession(deps);
    expect(log.signals.every((s) => !s.aborted)).toBe(true);
    session.close();
    expect(log.signals.length).toBe(2);
    expect(log.signals.every((s) => s.aborted)).toBe(true);
  });

  test('close() clears the 512 plaintext bytes from state once they were shown', async () => {
    const { deps, log } = harness();
    const session = startProofSession(deps);
    await tick();
    expect(log.plain.at(-1).status).toBe('ready'); // plaintext on screen
    session.close();
    expect(log.plain.at(-1)).toEqual(CLOSED_PLAIN_STATE);
    expect('plaintext' in log.plain.at(-1)).toBe(false);
    expect(log.cipher.at(-1)).toEqual({ status: 'idle' });
  });

  test('a decrypt that finishes after close() never puts plaintext back in state', async () => {
    let finish;
    const { deps, log } = harness({
      decrypt: (_signal, onSource) => new Promise((resolve) => { finish = () => { onSource('cache'); resolve('p'); }; }),
    });
    const session = startProofSession(deps);
    await tick();
    session.close();
    finish();
    await tick();
    expect(log.plain.some((s) => s.status === 'ready')).toBe(false);
  });

  test('the component resets both panes when the sheet is hidden', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, '../components/EncryptionProof.tsx'), 'utf8');
    expect(src).toMatch(/if \(!visible\) \{\s*setPlain\(CLOSED_PLAIN_STATE\);\s*setCipher\(CLOSED_CIPHER_STATE\);/);
    expect(src).toMatch(/return \(\) => session\.close\(\);/);
  });

  test('the component gives its copy back through releasePreviewCopy under the SAME key it decrypted (P2-F)', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, '../components/EncryptionProof.tsx'), 'utf8');
    expect(src).toMatch(/releaseCopy: \(\) => releasePreviewCopy\(file\.id, cacheExt\),/);
    expect(src).toMatch(/decryptToTempFile\(\s*file\.id,[^;]*?cacheExt,/);
    expect(src).not.toMatch(/deleteAsync\([^)]*preview/i);
  });

  test('the Photos pager gives its preview copy back too, never deletes the shared file (P2-F)', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, '../screens/PreviewScreen.tsx'), 'utf8');
    expect(src).toMatch(/if \(cachedUri !== decryptedUri\) \{\s*await releasePreviewCopy\(entry\.id, ext\);/);
    expect(src).toMatch(/if \(signal\?\.aborted\) \{[\s\S]{0,250}await releasePreviewCopy\(entry\.id, ext\);/);
    expect(src).not.toMatch(/deleteAsync\(decryptedUri/);
  });

  test('too large to decrypt: no decrypt at all, still only the ranged ciphertext fetch', async () => {
    const { deps, log } = harness({ sizeBytes: PROOF_DECRYPT_MAX_BYTES + 1 });
    startProofSession(deps);
    await tick();
    expect(log.decrypts).toBe(0);
    expect(log.plain.at(-1)).toEqual({ status: 'too-large' });
    expect(log.prefixFetches).toEqual([PROOF_BYTES]);
  });
});

/** A 10 MiB 200-response body served in 64 KiB chunks, counting what was pulled. */
function bigStream(stats) {
  const total = 10 * 1024 * 1024;
  const chunk = 64 * 1024;
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) { controller.close(); return; }
      const n = Math.min(chunk, total - sent);
      stats.pulled += n;
      controller.enqueue(new Uint8Array(n).fill(sent === 0 ? 0x01 : 0x02));
      sent += n;
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
}

describe('fetchCiphertextPrefix', () => {
  test('asks for bytes 0-511 only (Range header) with the bearer token', async () => {
    let seen;
    await fetchCiphertextPrefix('https://api.test/api/v1/files/f/download', 'tok', 512, async (url, init) => {
      seen = { url, headers: init.headers };
      return new Response(new Uint8Array(512), { status: 206 });
    });
    expect(seen.headers.Range).toBe('bytes=0-511');
    expect(seen.headers.Authorization).toBe('Bearer tok');
  });

  test('206: returns the 512 bytes', async () => {
    const body = new Uint8Array(512).map((_, i) => i & 0xff);
    const out = await fetchCiphertextPrefix('u', 't', 512, async () => new Response(body, { status: 206 }));
    expect(out).toEqual(body);
  });

  test('206 with an over-long body (P2-D): reads only 512 bytes from the stream and cancels', async () => {
    const stats = { pulled: 0, cancelled: false };
    let requestSignal;
    const out = await fetchCiphertextPrefix('u', 't', 512, async (_u, init) => {
      requestSignal = init.signal;
      return new Response(bigStream(stats), { status: 206 });
    });
    expect(out.length).toBe(512);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(64 * 1024);
    expect(requestSignal.aborted).toBe(true);
  });

  test('206 without a readable stream is refused, never buffered whole (P2-D)', async () => {
    let buffered = false;
    const res = { ok: true, status: 206, body: null, arrayBuffer: async () => { buffered = true; return new ArrayBuffer(10 * 1024 * 1024); } };
    await expect(fetchCiphertextPrefix('u', 't', 512, async () => res)).rejects.toThrow();
    expect(buffered).toBe(false);
  });

  test('200 (server ignored Range): reads only the first 512 bytes and cancels the transfer', async () => {
    const stats = { pulled: 0, cancelled: false };
    let requestSignal;
    const out = await fetchCiphertextPrefix('u', 't', 512, async (_u, init) => {
      requestSignal = init.signal;
      return new Response(bigStream(stats), { status: 200 });
    });
    expect(out.length).toBe(512);
    expect(out[0]).toBe(0x01);
    expect(stats.cancelled).toBe(true);
    expect(stats.pulled).toBeLessThanOrEqual(64 * 1024); // one chunk of 10 MiB, not the file
    expect(requestSignal.aborted).toBe(true);
  });

  test('never falls back to buffering the whole body when there is no stream', async () => {
    let buffered = false;
    const res = { ok: true, status: 200, body: null, arrayBuffer: async () => { buffered = true; return new ArrayBuffer(10); } };
    await expect(fetchCiphertextPrefix('u', 't', 512, async () => res)).rejects.toThrow();
    expect(buffered).toBe(false);
  });

  test('an HTTP error is an error', async () => {
    await expect(fetchCiphertextPrefix('u', 't', 512, async () => new Response('no', { status: 404 }))).rejects.toThrow('HTTP 404');
  });

  test('the caller signal aborts the request', async () => {
    const c = new AbortController();
    let requestSignal;
    const p = fetchCiphertextPrefix('u', 't', 512, (_u, init) => {
      requestSignal = init.signal;
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }, c.signal);
    c.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(requestSignal.aborted).toBe(true);
  });
});
