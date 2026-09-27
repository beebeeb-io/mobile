// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
import { describe, expect, test } from 'bun:test';
import { displayedSizeBytes, savedFileMetaFrom } from './saved-file-meta';

describe('saved-file-meta — the preview size after a save (task 1592 item 5)', () => {
  test('after a save the displayed size is the saved file\'s, not the size it opened with', () => {
    // The 222 regression: opened at 15 B, saved to 33 B, header still said 15 B.
    const saved = savedFileMetaFrom('f1', 'x'.repeat(33), { size_bytes: 33 });
    expect(displayedSizeBytes('f1', 15, saved)).toBe(33);
  });

  test('prefers the server\'s fresh size_bytes over the local text length', () => {
    expect(savedFileMetaFrom('f1', 'abc', { size_bytes: 276 }).sizeBytes).toBe(276);
  });

  test('without a fresh read, uses the UTF-8 byte length (not the JS string length)', () => {
    expect(savedFileMetaFrom('f1', 'héllo €', null).sizeBytes).toBe(10); // 7 chars, 10 bytes
    expect(savedFileMetaFrom('f1', '', undefined).sizeBytes).toBe(0);
  });

  test('another file (a pager swipe) keeps its own size; no save keeps the opened size', () => {
    const saved = savedFileMetaFrom('f1', 'abc', { size_bytes: 3 });
    expect(displayedSizeBytes('f2', 900, saved)).toBe(900);
    expect(displayedSizeBytes('f1', 15, null)).toBe(15);
  });
});
