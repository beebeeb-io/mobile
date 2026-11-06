// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 1683j — the pure streaming contracts: which extensions route to
 * `streamVideoNative`, what a loopback stream URI looks like, and how a
 * native streaming progress event maps to the buffered percent the UI shows.
 *
 * RED first: `src/lib/video-stream.ts` does not exist until the routing +
 * UI wiring lands (run 2). Mutation evidence: comments in each block.
 */
import { describe, expect, test } from 'bun:test';
import {
  STREAMABLE_VIDEO_EXTENSIONS,
  isLoopbackStreamUri,
  isStreamableVideoExtension,
  startupBufferingText,
  streamBufferPctFromEvent,
} from './video-stream';

describe('1683j isStreamableVideoExtension — the routing gate', () => {
  test('the video extensions the vault actually stores stream', () => {
    for (const ext of ['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp']) {
      expect(isStreamableVideoExtension(ext)).toBe(true);
    }
    // Case-insensitive: extensionForMime yields lowercase, but a filename-
    // derived cache name (previewDecryptExtension's fallback) may keep case.
    expect(isStreamableVideoExtension('MP4')).toBe(true);
    expect(isStreamableVideoExtension('.Mp4')).toBe(true);
  });

  test('non-video types keep the whole-file path', () => {
    for (const ext of ['pdf', 'jpg', 'png', 'txt', 'docx', 'mp3', 'wav', '', null, undefined]) {
      expect(isStreamableVideoExtension(ext)).toBe(false);
    }
  });

  test('audio formats never stream (mp3/m4a are audio/*, not video/*)', () => {
    expect(isStreamableVideoExtension('m4a')).toBe(false);
    expect(isStreamableVideoExtension('m4b')).toBe(false);
  });

  test('the set is frozen — no accidental additions', () => {
    expect(Object.isFrozen(STREAMABLE_VIDEO_EXTENSIONS)).toBe(true);
  });
});

describe('1683j isLoopbackStreamUri — the player-vs-filepath discriminator', () => {
  test('the engine\u2019s loopback stream URIs match', () => {
    expect(isLoopbackStreamUri('http://127.0.0.1:41234/s/abc123/v.mp4')).toBe(true);
    expect(isLoopbackStreamUri('http://localhost:41234/s/abc123/v.mp4')).toBe(true);
  });

  test('everything else is a local file and must not look like a stream', () => {
    expect(isLoopbackStreamUri('file:///data/user/0/io.beebeeb.app/cache/preview/x.mp4')).toBe(false);
    expect(isLoopbackStreamUri('http://10.0.0.2:8081/x')).toBe(false);
    expect(isLoopbackStreamUri('https://api.beebeeb.io/v1/files/x')).toBe(false);
    expect(isLoopbackStreamUri('')).toBe(false);
    expect(isLoopbackStreamUri(null)).toBe(false);
    expect(isLoopbackStreamUri(undefined)).toBe(false);
  });
});

describe('1683j streamBufferPctFromEvent — the "Streaming · N% buffered" mapping', () => {
  test('a streaming decrypt event maps to the buffered percent', () => {
    expect(
      streamBufferPctFromEvent({ stage: 'decrypting', streaming: true, chunksCompleted: 8, chunksTotal: 19 }),
    ).toBe(42);
    expect(
      streamBufferPctFromEvent({ stage: 'decrypting', streaming: true, chunksCompleted: 19, chunksTotal: 19 }),
    ).toBe(100);
  });

  test('non-streaming decrypt events leave the value UNCHANGED (undefined)', () => {
    // The whole-file path's decrypt events carry no streaming flag — the UI
    // must not mistake them for stream buffering.
    expect(
      streamBufferPctFromEvent({ stage: 'decrypting', chunksCompleted: 8, chunksTotal: 19 }),
    ).toBe(undefined);
    expect(streamBufferPctFromEvent({ stage: 'decrypting', streaming: false, chunksCompleted: 8, chunksTotal: 19 })).toBe(
      undefined,
    );
  });

  test('download events never change the buffered percent', () => {
    expect(
      streamBufferPctFromEvent({ stage: 'downloading', streaming: true, bytesDownloaded: 100, bytesTotal: 400 }),
    ).toBe(undefined);
  });

  test('terminal stages clear the badge (null)', () => {
    expect(streamBufferPctFromEvent({ stage: 'complete' })).toBe(null);
    expect(streamBufferPctFromEvent({ stage: 'error', error: 'x' })).toBe(null);
    expect(streamBufferPctFromEvent({ stage: 'complete', streaming: true, chunksCompleted: 19, chunksTotal: 19 })).toBe(
      null,
    );
  });

  test('zero totals never divide by zero', () => {
    expect(streamBufferPctFromEvent({ stage: 'decrypting', streaming: true, chunksCompleted: 0, chunksTotal: 0 })).toBe(
      undefined,
    );
  });
});

describe('2335 startupBufferingText — bytes done of bytes needed before the player starts', () => {
  // The CLI's 128 MiB chunks: the stream needs chunk 0 and the tail chunk whole
  // (about 166 MB) before the player gets a URL. That wait used to show
  // "Downloading video..." with no number.
  test('a startup buffering event reads "Buffering <done> of <needed>"', () => {
    expect(startupBufferingText({ stage: 'downloading', buffering: true, bytesDownloaded: 52_400_000, bytesTotal: 165_913_144 }))
      .toBe('Buffering 52 MB of 166 MB');
    expect(startupBufferingText({ stage: 'downloading', buffering: true, bytesDownloaded: 0, bytesTotal: 165_913_144 }))
      .toBe('Buffering 0 B of 166 MB');
  });

  test('done never shows more than needed', () => {
    expect(startupBufferingText({ stage: 'downloading', buffering: true, bytesDownloaded: 200_000_000, bytesTotal: 165_913_144 }))
      .toBe('Buffering 166 MB of 166 MB');
  });

  test('no total yet, or not a startup buffering event: no buffering text (null)', () => {
    expect(startupBufferingText({ stage: 'downloading', buffering: true, bytesDownloaded: 10, bytesTotal: 0 })).toBe(null);
    // The whole-file path's download events carry no buffering flag: they keep
    // their own "Downloading X of Y" text.
    expect(startupBufferingText({ stage: 'downloading', bytesDownloaded: 10, bytesTotal: 100 })).toBe(null);
    expect(startupBufferingText({ stage: 'downloading', buffering: false, bytesDownloaded: 10, bytesTotal: 100 })).toBe(null);
    expect(startupBufferingText({ stage: 'decrypting', buffering: true, bytesDownloaded: 10, bytesTotal: 100 })).toBe(null);
    expect(startupBufferingText(null)).toBe(null);
  });
});
