// @ts-nocheck
// Task 1683j — the streaming-video UI contract, checked at source level (bun
// test here has no React reconciler; PreviewScreen cannot be unit-tested —
// see PreviewScreen.webview-parent.test.ts's doc comment for the convention).
//
// Asserted:
//  1. The pre-play progress row reads "Streaming · N% buffered" for a
//     streaming session (progressStageText's streaming branch) — Guus's
//     specified copy.
//  2. A PLAYING streamed video keeps showing the buffered percent via the
//     StreamingBufferBadge (the load row is cleared at resolve time; the
//     badge rides the stream's own progress pump).
//  3. The badge renders ONLY for loopback stream URIs (a local file — cached
//     video, offline copy — must never show it).
//  4. The pager's video path skips the video-cache copy for a stream uri
//     (copyAsync on an http uri would throw; the player starts NOW).
//
// Mutation evidence: each block below was seen RED by deleting the asserted
// construct from PreviewScreen.tsx (badge branch / streaming text / pager
// gate) and GREEN after restore.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');

describe('1683j — streaming video UI (source contract)', () => {
  test('the progress row renders the specified "Streaming · N% buffered" copy', () => {
    expect(source).toContain('`Streaming · ${buffered}% buffered`');
  });

  test('the streaming branch keys off the progress state\u2019s streaming flag', () => {
    // The whole-file path's decrypt events must NOT hit the streaming text.
    expect(source).toMatch(/if \(progress\.streaming\) \{[\s\S]*?Streaming · /);
  });

  test('applyNativeProgress carries the streaming flag into the state', () => {
    expect(source).toMatch(/streaming: event\.streaming \?\? prev\.streaming/);
  });

  test('a playing streamed video shows the buffered badge (single-file stage)', () => {
    expect(source).toContain('StreamingBufferBadge pct={streamBufferPct}');
  });

  test('the badge is gated on a loopback stream uri — never on a local file', () => {
    expect(source).toMatch(/isLoopbackStreamUri\(videoUri\) && streamBufferPct != null/);
    expect(source).toMatch(/isLoopbackStreamUri\(uri\) && streamBufferPct != null/);
  });

  test('the single-file video effect feeds the stream\u2019s buffered percent', () => {
    expect(source).toMatch(/onStreamProgress: setStreamBufferPct/);
  });

  test('the pager\u2019s video path skips the cache copy for a stream uri', () => {
    expect(source).toMatch(/isLoopbackStreamUri\(decryptedUri\)[\s\S]{0,400}return \{ uri: decryptedUri, kind: 'original' \}/);
  });

  test('cleanup never deleteAsync-es a stream uri (lease release instead)', () => {
    expect(source).toMatch(/isLoopbackStreamUri\(uri\)\)[\s\S]{0,300}releasePreviewCopy/);
  });
});
