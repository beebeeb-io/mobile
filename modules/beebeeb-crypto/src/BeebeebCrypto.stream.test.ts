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

  test('playable trace does not include the loopback stream URI capability', async () => {
    await crypto.streamVideoNative(7, 'https://api.test', 'tok', 'video', 'file:///cache/preview/video.mp4', 5000, 4);

    expect(JSON.stringify(tracePayloads)).not.toContain('secret-capability');
  });
});
