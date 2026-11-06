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
const wholeFileCalls: string[] = [];
/** Task 2335 delta review: deletes of these URIs throw. */
const failDeletes = new Set<string>();
/** Task 2335 review: a native cancel for this file id waits on its gate (a slow queue drain). */
const cancelGates = new Map<string, Promise<void>>();

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
    if (failDeletes.has(uri)) throw new Error('EPERM');
    const block = deleteBlocks.get(uri);
    if (block) {
      deleteBlocks.delete(uri);
      await block;
    }
    for (const k of [...files.keys()]) if (k === uri || (uri.endsWith('/') && k.startsWith(uri))) files.delete(k);
  },
  writeAsStringAsync: async () => {},
  readAsStringAsync: async () => '',
  // Task 2335 review: the export copy is moved into its export folder.
  moveAsync: async ({ from, to }) => {
    if (!files.has(from)) throw new Error(`no such file: ${from}`);
    files.set(to, files.get(from));
    files.delete(from);
  },
  copyAsync: async ({ from, to }) => { files.set(to, files.get(from) ?? 0); },
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  isNativeAvailable: true,
  decryptLocalFileNative: async () => { throw new Error('not exercised'); },
  // Task 2335 review: only an export copy (its own `.export-` key) may take the whole-file path.
  downloadAndDecryptFileNative: async (_h, _api, _tok, _fileId, outputPath) => {
    if (!String(outputPath).includes('.export-')) throw new Error('whole-file path must not run');
    wholeFileCalls.push(outputPath);
    files.set(outputPath, 5000);
    return { outputUri: outputPath, plaintextSize: 5000 };
  },
  streamVideoNative: async (_h, _api, _tok, fileId, outputPath, _size, _chunks, opts) => {
    if (fileId === 'vfail') throw new Error('Chunk 0 response is missing X-Chunk-Count');
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
        const gate = cancelGates.get(fileId);
        if (gate) await gate;
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
const { prepareExportShareCopy } = await import('./export-share-copy');
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
  cancelGates.clear();
  wholeFileCalls.length = 0;
  failDeletes.clear();
  plaintextGate.open();
});

describe('1724 streaming preview lifetime', () => {
  test('task 2335 delta review: a failed delete on the last release is traced with a label only', async () => {
    const exportExtension = nd.exportDecryptExtension('pdf', () => 0.75);
    const copy = await nd.decryptToTempFile('vdelfail', null, exportExtension, 5000, 4, 7, { streamVideo: false });
    failDeletes.add(copy);
    try {
      expect(await nd.releasePreviewCopy('vdelfail', exportExtension)).toBe(true);
      const failed = traces.filter((trace) => trace.marker === 'preview.release.delete_failed');
      expect(failed).toEqual([{ marker: 'preview.release.delete_failed', payload: { label: 'preview copy' } }]);
    } finally {
      failDeletes.clear();
      await plaintextGate.purge(() => nd.clearPreviewCache());
    }
  });

  for (const outcome of ['saved', 'cancelled'] as const) {
    test(`task 2335 review: once the share sheet closes (${outcome}) no plaintext of the export is left, leased or on disk`, async () => {
      // handleDownload's shape: decrypt the export's own copy, move it into the export folder,
      // share, and release in `finally` whatever the sheet's outcome.
      const exportExtension = nd.exportDecryptExtension('mkv', () => 0.5);
      let copy: string | null = null;
      let cleanup: (() => Promise<void>) | null = null;
      try {
        copy = await nd.decryptToTempFile('vexported', null, exportExtension, 5000, 4, 7, { streamVideo: false });
        const prepared = await prepareExportShareCopy({ sourceUri: copy, displayName: 'Holiday.mkv', idBasedName: 'vexported.mkv', moveSource: true });
        cleanup = prepared.cleanup;
        expect(files.has(copy)).toBe(false); // moved, not copied: one plaintext
        expect(files.has(prepared.uri)).toBe(true);
        await Promise.resolve(outcome); // Sharing.shareAsync resolves whether the user saved or cancelled
      } finally {
        await cleanup?.();
        await nd.releasePreviewCopy('vexported', exportExtension);
      }
      expect(nd.isPreviewPathLeased(copy!)).toBe(false);
      expect([...files.keys()].filter((key) => key.includes('vexported') || key.includes('beebeeb-export/'))).toEqual([]);
    });
  }

  test('task 2335 review: an export during a live stream decrypts its own whole file, and its release leaves no plaintext', async () => {
    const streamUri = await nd.decryptToTempFile('vsave', null, 'mp4', 5000, 4, 7);
    expect(streamUri).toBe('http://127.0.0.1:41234/s/vsave/v.mp4');
    const exportExtension = nd.exportDecryptExtension('mp4', () => 0.25);
    expect(exportExtension).toBe('export-3fffffff.mp4');
    try {
      const exportCopy = await nd.decryptToTempFile('vsave', null, exportExtension, 5000, 4, 7, { streamVideo: false });
      // Never the stream's loopback URI (the share sheet cannot take it), never a second stream.
      expect(exportCopy).toBe('file:///cache/preview/vsave.export-3fffffff.mp4');
      expect(streamCalls.length).toBe(1);
      expect(wholeFileCalls).toEqual([exportCopy]);
      expect(traces.some((trace) => trace.marker === 'preview.decrypt.stream.join_active')).toBe(false);
      expect(nd.isPreviewPathLeased(exportCopy)).toBe(true);

      // The share sheet closed (saved or cancelled): no leased plaintext and no file is left.
      expect(await nd.releasePreviewCopy('vsave', exportExtension)).toBe(true);
      expect(nd.isPreviewPathLeased(exportCopy)).toBe(false);
      expect(files.has(exportCopy)).toBe(false);
      // The stream itself is untouched.
      expect(cancelCalls).toBe(0);
    } finally {
      await plaintextGate.purge(() => nd.clearPreviewCache());
    }
  });

  test('task 2335 review: an open while the last release is still cancelling waits, then starts fresh (never joins the dying stream)', async () => {
    // A player error releases the stream fire-and-forget; native cancel drains its queues first
    // (seconds with 128 MiB chunks). A Try again in that window used to join the dying stream,
    // whose close then deleted the output under the new player.
    const outputPath = 'file:///cache/preview/vrace.mp4';
    await nd.decryptToTempFile('vrace', null, 'mp4', 5000, 4, 7);
    let finishCancel!: () => void;
    cancelGates.set('vrace', new Promise<void>((resolve) => { finishCancel = resolve; }));
    const releasing = nd.releasePreviewCopy('vrace', 'mp4');
    let retry: Promise<string> | null = null;
    try {
      await tick();
      expect(cancelCalls).toBe(1);

      let retryUri: string | null = null;
      retry = nd.decryptToTempFile('vrace', null, 'mp4', 5000, 4, 7).then((uri) => { retryUri = uri; return uri; });
      for (let i = 0; i < 5; i += 1) await tick();
      expect(retryUri).toBe(null); // it waits for the teardown instead of joining
      expect(traces.some((trace) => trace.marker === 'preview.decrypt.stream.join_active')).toBe(false);

      finishCancel();
      expect(await releasing).toBe(true);
      await retry;
      expect(streamCalls.length).toBe(2); // a fresh native stream
      expect(retryUri).toBe('http://127.0.0.1:41234/s/vrace/v.mp4');
      expect(files.has(outputPath)).toBe(true); // the old close did not delete the new stream's output
    } finally {
      // Leave no stream or lease behind for the next test, pass or fail.
      finishCancel();
      await releasing.catch(() => {});
      await retry?.catch(() => {});
      await plaintextGate.purge(() => nd.clearPreviewCache());
    }
  });

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



  test('a cancelled terminal evicts the loopback and export rejects before retry', async () => {
    await nd.decryptToTempFile('vcancelled', null, 'mp4', 5000, 4, 7);
    const releaseOldDelete = blockNextDelete('file:///cache/preview/vcancelled.mp4');

    await streamCalls[0].cancel();
    await until(() => deletes.includes('file:///cache/preview/vcancelled.mp4'));

    await expect(nd.materializeVideoPreviewForExport('vcancelled', 'mp4')).rejects.toMatchObject({ name: 'AbortError' });
    const retryPromise = nd.decryptToTempFile('vcancelled', null, 'mp4', 5000, 4, 7);
    await tick();
    expect(streamCalls.length).toBe(1);

    releaseOldDelete();
    const retry = await retryPromise;
    expect(retry).toBe('http://127.0.0.1:41234/s/vcancelled/v.mp4');
    expect(streamCalls.length).toBe(2);
    await nd.releasePreviewCopy('vcancelled', 'mp4');
    await nd.releasePreviewCopy('vcancelled', 'mp4');
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

  test('a stale chunk count from the file list is traced and the stream still plays', async () => {
    const uri = await nd.decryptToTempFile('vstale', null, 'mp4', 5000, 1, 7);
    expect(uri).toBe('http://127.0.0.1:41234/s/vstale/v.mp4');
    const stale = traces.filter((trace) => trace.marker === 'preview.decrypt.stream.declared_chunk_count_stale');
    expect(stale.length).toBe(1);
    expect(stale[0].payload).toMatchObject({ declaredChunkCount: 1, actualChunkCount: 4 });
    expect(traces.some((trace) => trace.marker === 'preview.decrypt.stream.failed_fallback')).toBe(false);
    await nd.releasePreviewCopy('vstale', 'mp4');
  });

  test('a matching chunk count is not traced as stale', async () => {
    await nd.decryptToTempFile('vfresh', null, 'mp4', 5000, 4, 7);
    expect(traces.some((trace) => trace.marker === 'preview.decrypt.stream.declared_chunk_count_stale')).toBe(false);
    await nd.releasePreviewCopy('vfresh', 'mp4');
  });

  test('closing the preview while the pump still runs cancels it and deletes the plaintext', async () => {
    await nd.decryptToTempFile('vclose', null, 'mp4', 5000, 4, 7);
    expect(files.has('file:///cache/preview/vclose.mp4')).toBe(true);

    await nd.releasePreviewCopy('vclose', 'mp4');

    expect(cancelCalls).toBeGreaterThanOrEqual(1);
    expect(files.has('file:///cache/preview/vclose.mp4')).toBe(false);
    await tick();
    expect(plaintextGate.held()).toBe(0);
  });

  test('a stream that cannot start is logged with its reason before the full download takes over', async () => {
    await expect(nd.decryptToTempFile('vfail', null, 'mp4', 5000, 4, 7)).rejects.toThrow('whole-file path must not run');
    const fallback = traces.filter((trace) => trace.marker === 'preview.decrypt.stream.failed_fallback');
    expect(fallback.length).toBe(1);
    expect(fallback[0].payload.message).toContain('missing X-Chunk-Count');
    await tick();
    expect(plaintextGate.held()).toBe(0);
  });
});
