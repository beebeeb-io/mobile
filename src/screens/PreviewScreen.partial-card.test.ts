// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1687d — the honest partial-file card ("halve file" report). When a
// decrypt comes up short, the error card must say what the user is looking
// at ("Incomplete file") and what happened ("This file didn't fully
// decrypt.") — with the Try-again action that fetches a fresh copy — never
// render the decodable prefix silently. Same source-text convention as
// PreviewScreen.chrome-layer.test.ts. Mutation evidence in task 1687 Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');

describe('task 1687d — the partial-file error card', () => {
  test('renderLoadError keys a dedicated branch on the partial-decrypt message', () => {
    expect(source).toMatch(/const partial = message === PARTIAL_DECRYPT_MESSAGE/);
    expect(source).toMatch(/'Incomplete file'/);
  });

  test('the partial card comes from the shared error card (title + message + Try again), not a silent path', () => {
    const at = source.indexOf('const partial = message === PARTIAL_DECRYPT_MESSAGE');
    const region = source.slice(at, at + 1400);
    expect(region).toContain('resolvedTitle');
    expect(region).toContain('preview-load-retry');
  });

  test('the still-uploading title handling is preserved (1592, unchanged)', () => {
    expect(source).toMatch(/stillUploading \? 'Still uploading' : title/);
  });
});