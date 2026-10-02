// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 1685 review should-fixes 1+2 — source guards for the upload gate wiring
// in FilesScreen. Same source-text convention as FilesScreen.region.test.ts:
// no React reconciler here, so the WIRING is what these guards check.
//
// Should-fix 1: a second pick during a running batch must QUEUE behind it, not
// start a second concurrent serial loop (two writers on the single `upload`
// card state; 2 concurrent encrypted streams).
// Should-fix 2: a row that is uploading right now must never be offered a
// Resume (duplicate chunk PUTs / double finalize).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'FilesScreen.tsx'), 'utf-8');

function callbackBody(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('should-fix 1 — one upload loop at a time', () => {
  test('the screen owns a serialized upload gate', () => {
    expect(source).toContain('uploadGateRef');
    expect(source).toContain('createUploadGate()');
  });

  test('the photo batch runs THROUGH the gate', () => {
    expect(callbackBody(
      'const pickAndUploadPhotos = useCallback',
      'const openDocumentScanner',
    )).toContain('gate.run(');
  });

  test('the single-file upload runs THROUGH the gate', () => {
    expect(callbackBody(
      'const pickAndUploadFile = useCallback',
      'const pickAndUploadPhotos',
    )).toContain('gate.run(');
  });

  test('a resumed upload runs THROUGH the gate', () => {
    expect(callbackBody(
      'const resumePendingUpload = useCallback',
      '// Task 1685 fix 3',
    )).toContain('gate.run(');
  });

  test('a pick made while busy tells the user it is queued (honest, not a silent stall)', () => {
    const body = callbackBody(
      'const pickAndUploadPhotos = useCallback',
      'const openDocumentScanner',
    );
    expect(body).toContain('isBusy()');
    expect(body).toMatch(/starts when the current/);
  });
});

describe('should-fix 2 — no Resume for an actively-uploading row', () => {
  test('handlePendingUpload gates Resume through canOfferResume + the active-upload ref', () => {
    const body = callbackBody(
      'const handlePendingUpload = useCallback',
      'const ensureFileReady',
    );
    expect(body).toContain('canOfferResume(');
    expect(body).toContain('activeUploadFileIdRef.current');
    expect(body).toContain('isBusy()');
  });

  test('the in-flight fileId ref is set and cleared around every encryptedUpload', () => {
    const sets = source.match(/activeUploadFileIdRef\.current = /g) ?? [];
    expect(sets.length).toBeGreaterThanOrEqual(3); // single file, per-asset, resume
    const clears = source.match(/activeUploadFileIdRef\.current = null/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(3);
  });
});