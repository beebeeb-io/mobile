// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1568 — audio preview player: "decrypt to a temp file that is deleted
// on close" is proven here at the function level (PreviewScreen.tsx itself
// is not unit-testable — see preview-temp-file.ts's own doc comment).
// RED/GREEN mutation proof for this file is pasted in
// .claude/tasks/backlog/1568-mobile-audio-preview-player.md's Notes section.
import { describe, expect, test } from 'bun:test';
import { cleanupTrackedTempFile, type TempFileRef } from './preview-temp-file';

describe('cleanupTrackedTempFile', () => {
  test('deletes the tracked temp file exactly once, idempotently', async () => {
    const ref: TempFileRef = { current: 'file:///cache/abc123.wav' };
    const calls: Array<[string, { idempotent: boolean }]> = [];
    await cleanupTrackedTempFile(ref, async (uri, options) => {
      calls.push([uri, options]);
    });
    expect(calls).toEqual([['file:///cache/abc123.wav', { idempotent: true }]]);
  });

  test('clears the ref to null after deleting', async () => {
    const ref: TempFileRef = { current: 'file:///cache/abc123.wav' };
    await cleanupTrackedTempFile(ref, async () => {});
    expect(ref.current).toBeNull();
  });

  test('is a no-op (never calls deleteAsync) when nothing is tracked', async () => {
    const ref: TempFileRef = { current: null };
    let called = false;
    await cleanupTrackedTempFile(ref, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test('swallows a rejected delete instead of throwing', async () => {
    const ref: TempFileRef = { current: 'file:///cache/gone.wav' };
    await expect(
      cleanupTrackedTempFile(ref, async () => {
        throw new Error('ENOENT');
      }),
    ).resolves.toBeUndefined();
  });

  test('still clears the ref even when the delete rejects', async () => {
    const ref: TempFileRef = { current: 'file:///cache/gone.wav' };
    await cleanupTrackedTempFile(ref, async () => {
      throw new Error('ENOENT');
    });
    expect(ref.current).toBeNull();
  });
});
