// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let nativeModule: any = createNativeModule();
const tracePayloads: unknown[] = [];

function createNativeModule() {
  return {
    streamVideoNative: async (params) => ({
      streamUri: 'http://127.0.0.1:4444/s/secret-capability/v.mp4',
      outputUri: params.outputUri,
      outputPath: params.outputUri,
      plaintextSize: 5000,
      chunkCount: 4,
      streamId: 'native-stream-id',
    }),
    getPreviewLoadProgress: (requestId) => ({
      requestId,
      fileId: 'video',
      stage: 'decrypting',
      streaming: true,
      chunksCompleted: 1,
      chunksTotal: 4,
    }),
    cancelVideoStreamNative: async () => {},
    cancelDownloadAndDecryptFileNative: async () => {},
    logDiagnostic: (_marker, payload) => {
      if (payload) tracePayloads.push(JSON.parse(payload));
    },
  };
}

mock.module('expo', () => ({
  requireNativeModule: () => nativeModule,
}));

mock.module('expo-modules-core', () => ({
  requireOptionalNativeModule: () => null,
}));

const crypto = await import('./BeebeebCrypto');

beforeEach(() => {
  tracePayloads.length = 0;
  Object.keys(nativeModule).forEach((key) => { delete nativeModule[key]; });
  Object.assign(nativeModule, createNativeModule());
});

describe('streamVideoNative JS wrapper cancellation contract', () => {
  test('returned cancel uses cancelVideoStreamNative(streamId) when the native hook exists', async () => {
    const cancelVideoCalls: string[] = [];
    const cancelRequestCalls: string[] = [];
    nativeModule.cancelVideoStreamNative = async (streamId) => { cancelVideoCalls.push(streamId); };
    nativeModule.cancelDownloadAndDecryptFileNative = async (requestId) => { cancelRequestCalls.push(requestId); };

    const started = await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4);
    await started.cancel();

    expect(started.requestId.startsWith('stream-video-')).toBe(true);
    expect(cancelVideoCalls).toEqual(['native-stream-id']);
    expect(cancelRequestCalls).toEqual([]);
  });

  test('returned cancel falls back to cancelDownloadAndDecryptFileNative(requestId)', async () => {
    const cancelRequestCalls: string[] = [];
    delete nativeModule.cancelVideoStreamNative;
    nativeModule.cancelDownloadAndDecryptFileNative = async (requestId) => { cancelRequestCalls.push(requestId); };

    const started = await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4);
    await started.cancel();

    expect(cancelRequestCalls).toEqual([started.requestId]);
  });

  test('returned cancel stops polling immediately but keeps terminal pending until native cancel drains', async () => {
    let snapshotReads = 0;
    let finishNativeCancel!: () => void;
    nativeModule.cancelVideoStreamNative = async () => new Promise<void>((resolve) => { finishNativeCancel = resolve; });
    nativeModule.getPreviewLoadProgress = (requestId) => {
      snapshotReads += 1;
      return {
        requestId,
        fileId: 'video',
        stage: 'decrypting',
        streaming: true,
        chunksCompleted: 1,
        chunksTotal: 4,
      };
    };

    const started = await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4);
    let terminalSettled = false;
    started.terminal.then(() => { terminalSettled = true; });
    const cancelPromise = started.cancel();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const readsAfterCancel = snapshotReads;
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(snapshotReads).toBe(readsAfterCancel);
    expect(terminalSettled).toBe(false);
    finishNativeCancel();
    await cancelPromise;
    await started.terminal;
    expect(terminalSettled).toBe(true);
  });

  test('abort signal stops polling immediately but keeps terminal pending until native cancel drains', async () => {
    let snapshotReads = 0;
    let finishNativeCancel!: () => void;
    const controller = new AbortController();
    nativeModule.cancelVideoStreamNative = async () => new Promise<void>((resolve) => { finishNativeCancel = resolve; });
    nativeModule.getPreviewLoadProgress = (requestId) => {
      snapshotReads += 1;
      return {
        requestId,
        fileId: 'video',
        stage: 'decrypting',
        streaming: true,
        chunksCompleted: 1,
        chunksTotal: 4,
      };
    };

    const started = await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4, { signal: controller.signal });
    let terminalSettled = false;
    started.terminal.then(() => { terminalSettled = true; });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const readsAfterAbort = snapshotReads;
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(snapshotReads).toBe(readsAfterAbort);
    expect(terminalSettled).toBe(false);
    finishNativeCancel();
    await started.terminal;
    expect(terminalSettled).toBe(true);
  });




  test('abort keeps terminalStatus cancelled when final snapshot is an error while native start settles', async () => {
    let finishNativeCancel!: () => void;
    let finishNativeStart!: (value: unknown) => void;
    const controller = new AbortController();
    nativeModule.streamVideoNative = async (params) => new Promise((resolve) => {
      finishNativeStart = () => resolve({
        streamUri: 'http://127.0.0.1:4444/s/secret-capability/v.mp4',
        outputUri: params.outputUri,
        outputPath: params.outputUri,
        plaintextSize: 5000,
        chunkCount: 4,
        streamId: 'native-stream-id',
      });
    });
    nativeModule.cancelDownloadAndDecryptFileNative = async () => new Promise<void>((resolve) => { finishNativeCancel = resolve; });
    delete nativeModule.cancelVideoStreamNative;
    nativeModule.getPreviewLoadProgress = (requestId) => ({
      requestId,
      fileId: 'video',
      stage: 'error',
      streaming: true,
      error: 'late chunk auth failed',
    });

    const startPromise = crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4, { signal: controller.signal });
    controller.abort();
    finishNativeStart({});
    const started = await startPromise;
    let terminalSettled = false;
    started.terminal.then(() => { terminalSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminalSettled).toBe(false);
    finishNativeCancel();
    await expect(started.terminalStatus).resolves.toMatchObject({ stage: 'cancelled' });
  });


  test('terminalStatus reports native background stream errors without rejecting terminal', async () => {
    nativeModule.getPreviewLoadProgress = (requestId) => ({
      requestId,
      fileId: 'video',
      stage: 'error',
      streaming: true,
      error: 'late chunk auth failed',
    });

    const started = await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4);

    await started.terminal;
    await expect(started.terminalStatus).resolves.toMatchObject({
      stage: 'error',
      error: 'late chunk auth failed',
    });
  });

  test('playable trace does not include the loopback stream URI capability', async () => {
    await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4);

    expect(JSON.stringify(tracePayloads)).not.toContain('secret-capability');
  });
});

describe('task 2335 — startup buffering events reach the UI', () => {
  test('an event that changes only bytesTotal or the buffering flag is forwarded, not deduped away', async () => {
    // The native startup reports "bytes done of bytes needed". Its first event has the same
    // bytesDownloaded (0) as the opening {downloading, 0, 0}, and the need shrinks from an upper
    // bound to the exact size while bytesDownloaded stands still. The old key
    // (stage + chunksCompleted ?? bytesDownloaded) dropped both.
    const snapshots = [
      { stage: 'downloading', bytesDownloaded: 0, bytesTotal: 0 },
      { stage: 'downloading', bytesDownloaded: 0, bytesTotal: 268_000_000, buffering: true },
      { stage: 'downloading', bytesDownloaded: 134_000_000, bytesTotal: 268_000_000, buffering: true },
      { stage: 'downloading', bytesDownloaded: 134_000_000, bytesTotal: 166_000_000, buffering: true },
    ];
    let current = 0;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    nativeModule.getPreviewLoadProgress = (requestId) => ({ requestId, fileId: 'video', ...snapshots[current] });
    const baseStart = nativeModule.streamVideoNative;
    nativeModule.streamVideoNative = async (params) => { await startGate; return baseStart(params); };
    const seen: Array<{ bytesDownloaded?: number; bytesTotal?: number; buffering?: boolean }> = [];
    const startPromise = crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4, {
      onProgress: (ev) => { seen.push({ bytesDownloaded: ev.bytesDownloaded, bytesTotal: ev.bytesTotal, buffering: ev.buffering }); },
    });
    for (let i = 0; i < snapshots.length; i += 1) {
      current = i;
      await new Promise((resolve) => setTimeout(resolve, 260)); // longer than the 200 ms poll
    }
    // What the 200 ms poll forwarded (the wrapper's `finally` re-forwards the last snapshot once
    // the native start settles, by design, so the check stops before that).
    const forwardedByPoll = [...seen];
    releaseStart();
    const started = await startPromise;
    await started.cancel();
    expect(forwardedByPoll).toEqual([
      { bytesDownloaded: 0, bytesTotal: 0, buffering: undefined },
      { bytesDownloaded: 0, bytesTotal: 268_000_000, buffering: true },
      { bytesDownloaded: 134_000_000, bytesTotal: 268_000_000, buffering: true },
      { bytesDownloaded: 134_000_000, bytesTotal: 166_000_000, buffering: true },
    ]);
  });
});

describe('native manual upload progress', () => {
  test('a transfer that finishes before the first poll still emits its final chunk progress', async () => {
    nativeModule.uploadChunksNative = async () => ({
      chunksUploaded: 1,
      bytesUploaded: 10_028,
      bytesTotal: 10_028,
      cryptoBytesPerSec: 500_000,
    });
    nativeModule.getUploadProgressNative = () => null;
    const events: unknown[] = [];

    await crypto.uploadChunksNative({
      handleId: 1,
      apiUrl: 'https://api.test',
      token: 'token',
      fileId: 'file-1',
      inputUri: 'file:///small.txt',
      uploadSessionId: 'session-1',
      chunkSizeBytes: 4 * 1024 * 1024,
      chunkCount: 1,
      startChunkIndex: 0,
    }, {
      onProgress: (event) => events.push(event),
      pollIntervalMs: 60_000,
    });

    expect(events).toEqual([{
      requestId: expect.stringContaining('upload-file-1-'),
      stage: 'complete',
      chunksUploaded: 1,
      chunksTotal: 1,
      bytesUploaded: 10_028,
      bytesTotal: 10_028,
      cryptoBytesPerSec: 500_000,
    }]);
  });
});
