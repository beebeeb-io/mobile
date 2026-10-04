// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1724 — a playable loopback stream is not a completed preview copy.
 * Drive the real native-decrypt.ts with an in-memory file system and a
 * controllable native stream. RED before the registry fix: the second open
 * sees the partial outputPath, deletes it as a bad cache entry, and starts a
 * duplicate native stream; purge/last release also leave the native pump alive.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const files = new Map<string, number>();
const deletes: string[] = [];
const deleteBlocks = new Map<string, Promise<void>>();
const streamCalls: Array<{ outputPath: string; signal?: AbortSignal; finish: () => void; fail: () => void; cancel: () => Promise<void> }> = [];
const traces: Array<{ marker: string; payload?: Record<string, unknown> }> = [];
let cancelCalls = 0;

mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async (uri) => {
    if (uri.endsWith('/')) return { exists: true };
    return files.has(uri) ? { exists: true, size: files.get(uri), modificationTime: Date.now() / 1000 } : { exists: false };
  },
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir)).map((k) => k.slice(dir.length)),
  deleteAsync: async (uri) => {
    deletes.push(uri);
    const block = deleteBlocks.get(uri);
    if (block) {
      deleteBlocks.delete(uri);
      await block;
    }
    for (const k of [...files.keys()]) if (k === uri || (uri.endsWith('/') && k.startsWith(uri))) files.delete(k);
  },
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  isNativeAvailable: true,
  decryptLocalFileNative: async () => { throw new Error('not exercised'); },
  downloadAndDecryptFileNative: async () => { throw new Error('whole-file path must not run'); },
  streamVideoNative: async (_h, _api, _tok, fileId, outputPath, _size, _chunks, opts) => {
    files.set(outputPath, 100);
    let finishTerminal!: () => void;
    let finishTerminalStatus!: (value: unknown) => void;
    const terminal = new Promise<void>((resolve) => { finishTerminal = resolve; });
    const terminalStatus = new Promise((resolve) => { finishTerminalStatus = resolve; });
    const entry = {
      outputPath,
      signal: opts?.signal,
      finish: () => {
        files.set(outputPath, 5000);
        opts?.onProgress?.({ requestId: `stream-${fileId}`, fileId, stage: 'complete', streaming: true, chunksCompleted: 4, chunksTotal: 4 });
        finishTerminalStatus({ stage: 'complete' });
        finishTerminal();
      },
      fail: () => {
        opts?.onProgress?.({ requestId: `stream-${fileId}`, fileId, stage: 'error', streaming: true, error: 'late chunk auth failed' });
        finishTerminalStatus({ stage: 'error', error: 'late chunk auth failed' });
        finishTerminal();
      },
      cancel: async () => {
        cancelCalls += 1;
        finishTerminalStatus({ stage: 'cancelled' });
        finishTerminal();
      },
    };
    opts?.signal?.addEventListener('abort', () => { void entry.cancel(); });
    streamCalls.push(entry);
    opts?.onProgress?.({ requestId: `stream-${fileId}`, fileId, stage: 'decrypting', streaming: true, chunksCompleted: 1, chunksTotal: 4 });
    if (fileId === 'vabort') await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      streamUri: `http://127.0.0.1:41234/s/${fileId}/v.mp4`,
      outputUri: outputPath,
      outputPath,
      plaintextSize: 5000,
      chunkCount: 4,
      streamId: `sid-${fileId}`,
      requestId: `rid-${fileId}`,
      cancel: entry.cancel,
      terminal,
      terminalStatus,
    };
  },
}));
mock.module('./encrypted-download', () => ({
  CHUNK_SIZE: 1024,
  decryptEncryptedBytes: async () => new Uint8Array(),
  inferChunkCountFromEncryptedSize: () => 1,
}));
mock.module('./decrypt-to-file', () => ({
  decryptChunksToFile: async () => 0,
  DecryptToFileUnavailableError: class extends Error {},
  isDecryptToFileReady: () => false,
}));
mock.module('./api', () => ({
  ApiError: class extends Error {},
  friendlyError: (err: unknown) => err instanceof Error ? err.message : String(err),
  getApiUrl: () => 'https://api.test',
  getDownloadUrl: (id) => `https://api.test/api/v1/files/${id}/download`,
  getToken: async () => 'tok',
}));
mock.module('./rate-limited-fetch', () => ({ rateLimitedFetch: async () => { throw new Error('no js download here'); } }));
mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: (marker, payload) => { traces.push({ marker, payload }); },
}));
mock.module('./offline-manager', () => ({
  offlineManager: { init: async () => {}, isAvailable: () => false, getMeta: () => null },
  offlineFilePath: (id) => `file:///offline/${id}`,
}));
mock.module('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true }) } }));

const nd = await import('./native-decrypt');
const { plaintextGate } = await import('./plaintext-gate');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function blockNextDelete(uri: string) {
  let release!: () => void;
  deleteBlocks.set(uri, new Promise<void>((resolve) => { release = resolve; }));
  return release;
}
async function until(pred: () => boolean) {
  for (let i = 0; i < 50 && !pred(); i++) await tick();
}

beforeEach(() => {
  files.clear();
  deletes.length = 0;
  deleteBlocks.clear();
  traces.length = 0;
  streamCalls.length = 0;
  cancelCalls = 0;
  plaintextGate.open();
});

describe('1724 streaming preview lifetime', () => {
  test('a playable stream keeps a plaintext gate lease until the native pump is terminal', async () => {
    const uri = await nd.decryptToTempFile('vlease', null, 'mp4', 5000, 4, 7);
    expect(uri).toBe('http://127.0.0.1:41234/s/vlease/v.mp4');
    expect(plaintextGate.held()).toBe(1);
    expect(JSON.stringify(traces.filter((trace) => trace.marker === 'preview.decrypt.stream.playable'))).not.toContain('127.0.0.1');

    streamCalls[0].finish();
    await tick();

    expect(plaintextGate.held()).toBe(0);
    expect(files.get('file:///cache/preview/vlease.mp4')).toBe(5000);
    await nd.releasePreviewCopy('vlease', 'mp4');
  });

  test('terminal stream still cancels its native route on last consumer release', async () => {
    const uri = await nd.decryptToTempFile('vterminalrelease', null, 'mp4', 5000, 4, 7);
    expect(uri).toBe('http://127.0.0.1:41234/s/vterminalrelease/v.mp4');
    streamCalls[0].finish();
    await tick();
    expect(plaintextGate.held()).toBe(0);

    expect(await nd.releasePreviewCopy('vterminalrelease', 'mp4')).toBe(true);

    expect(cancelCalls).toBe(1);
    expect(files.has('file:///cache/preview/vterminalrelease.mp4')).toBe(false);
  });

  test('terminal stream still cancels its native route during purge', async () => {
    await nd.decryptToTempFile('vterminalpurge', null, 'mp4', 5000, 4, 7);
    streamCalls[0].finish();
    await tick();
    expect(plaintextGate.held()).toBe(0);

    await plaintextGate.purge(() => nd.clearPreviewCache());

    expect(cancelCalls).toBe(1);
    expect(files.has('file:///cache/preview/vterminalpurge.mp4')).toBe(false);
  });

  test('a second open joins the active partial stream instead of deleting it or starting a duplicate writer', async () => {
    const first = await nd.decryptToTempFile('vjoin', null, 'mp4', 5000, 4, 7);
    expect(files.get('file:///cache/preview/vjoin.mp4')).toBe(100);

    const second = await nd.decryptToTempFile('vjoin', null, 'mp4', 5000, 4, 7);

    expect(second).toBe(first);
    expect(streamCalls.length).toBe(1);
    expect(deletes).not.toContain('file:///cache/preview/vjoin.mp4');
    expect(await nd.releasePreviewCopy('vjoin', 'mp4')).toBe(false);
    expect(cancelCalls).toBe(0);
    expect(await nd.releasePreviewCopy('vjoin', 'mp4')).toBe(true);
    expect(cancelCalls).toBe(1);
  });



  test('a late background stream error evicts the dead loopback so retry starts a fresh native request', async () => {
    const first = await nd.decryptToTempFile('vlateerror', null, 'mp4', 5000, 4, 7);
    expect(first).toBe('http://127.0.0.1:41234/s/vlateerror/v.mp4');

    streamCalls[0].fail();
    await tick();
    expect(plaintextGate.held()).toBe(0);

    const second = await nd.decryptToTempFile('vlateerror', null, 'mp4', 5000, 4, 7);

    expect(second).toBe('http://127.0.0.1:41234/s/vlateerror/v.mp4');
    expect(streamCalls.length).toBe(2);
    await nd.releasePreviewCopy('vlateerror', 'mp4');
    await nd.releasePreviewCopy('vlateerror', 'mp4');
  });



  test('failed stream cleanup finishes before retry writes a healthy replacement output', async () => {
    await nd.decryptToTempFile('vcleanup', null, 'mp4', 5000, 4, 7);
    const releaseOldDelete = blockNextDelete('file:///cache/preview/vcleanup.mp4');

    streamCalls[0].fail();
    await until(() => deletes.includes('file:///cache/preview/vcleanup.mp4'));

    const retry = nd.decryptToTempFile('vcleanup', null, 'mp4', 5000, 4, 7);
    await tick();
    expect(streamCalls.length).toBe(1);

    releaseOldDelete();
    const retryUri = await retry;
    expect(retryUri).toBe('http://127.0.0.1:41234/s/vcleanup/v.mp4');
    expect(streamCalls.length).toBe(2);

    streamCalls[1].finish();
    await tick();
    expect(files.get('file:///cache/preview/vcleanup.mp4')).toBe(5000);
    await nd.releasePreviewCopy('vcleanup', 'mp4');
    await nd.releasePreviewCopy('vcleanup', 'mp4');
  });

  test('materializeVideoPreviewForExport waits for terminal success and returns a verified file URI', async () => {
    await nd.decryptToTempFile('vexport', null, 'mp4', 5000, 4, 7);

    let settled = false;
    const exported = nd.materializeVideoPreviewForExport('vexport', 'mp4').then((uri) => {
      settled = true;
      return uri;
    });
    await tick();
    expect(settled).toBe(false);

    streamCalls[0].finish();

    await expect(exported).resolves.toBe('file:///cache/preview/vexport.mp4');
    expect(settled).toBe(true);
    expect(files.get('file:///cache/preview/vexport.mp4')).toBe(5000);
    await nd.releasePreviewCopy('vexport', 'mp4');
  });

  test('materializeVideoPreviewForExport rejects on stream error and the next open retries', async () => {
    await nd.decryptToTempFile('vexporterror', null, 'mp4', 5000, 4, 7);
    const exported = nd.materializeVideoPreviewForExport('vexporterror', 'mp4');

    streamCalls[0].fail();

    await expect(exported).rejects.toThrow('late chunk auth failed');
    const retry = await nd.decryptToTempFile('vexporterror', null, 'mp4', 5000, 4, 7);
    expect(retry).toBe('http://127.0.0.1:41234/s/vexporterror/v.mp4');
    expect(streamCalls.length).toBe(2);
    await nd.releasePreviewCopy('vexporterror', 'mp4');
    await nd.releasePreviewCopy('vexporterror', 'mp4');
  });

  test('sign-out purge cancels a playable stream and removes the partial plaintext', async () => {
    await nd.decryptToTempFile('vpurge', null, 'mp4', 5000, 4, 7);

    await plaintextGate.purge(() => nd.clearPreviewCache());

    expect(cancelCalls).toBeGreaterThanOrEqual(1);
    expect(files.has('file:///cache/preview/vpurge.mp4')).toBe(false);
    expect(plaintextGate.held()).toBe(0);
  });

  test('aborting before playable cancels the native stream through the forwarded signal', async () => {
    const controller = new AbortController();
    const p = nd.decryptToTempFile('vabort', null, 'mp4', 5000, 4, 7, { signal: controller.signal });
    await until(() => streamCalls.length === 1);
    controller.abort();

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelCalls).toBeGreaterThanOrEqual(1);
    await tick();
    expect(files.has('file:///cache/preview/vabort.mp4')).toBe(false);
  });
});
