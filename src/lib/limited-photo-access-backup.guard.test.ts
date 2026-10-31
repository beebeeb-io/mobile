// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
//
// Camera-roll backup under iOS "Selected photos" access.
// Reproduced on the simulator: backup ran with full access, then access was
// narrowed to 0 selected photos. The manifest still held the 9 photos no
// longer shared; each one was "missing locally", counted as a FAILURE, and
// every 5 of them parked the drain for 60 s — forever "2 of 11", looping.
//
// Rules pinned against the shipped Swift source:
//   1. Under `.limited` access the scan scopes the manifest to what it
//      fetched (the album-selection mechanism: `selected_for_backup`), so
//      unshared photos leave the queue and the counts.
//   2. Under `.limited` access a library change triggers a full rescan (the
//      incremental path only inserts; it never sees a photo being unshared).
//   3. A photo that is gone or unshared is SKIPPED, not failed: it never
//      feeds the consecutive-failure backoff.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE = join(import.meta.dir, '..', '..', 'modules/beebeeb-crypto/ios/NativeBackupEngine.swift');
const source = readFileSync(ENGINE, 'utf-8');

/** Body of the first `func <name>(` up to the next member at the same indent. */
function functionBody(name: string): string {
  const start = source.search(new RegExp(`\\n  (?:private |fileprivate )?func ${name}\\(`));
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n  (?:@\w+ )?(?:private |fileprivate |static |override )*(?:func|var|let|enum|struct) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('limited photo access never loops the backup drain', () => {
  test('rule 1: the scan scopes the manifest to the fetched photos under limited access', () => {
    const scan = functionBody('scanPhotoLibraryForPendingUploads');
    expect(/hasAlbumSelection:\s*!selectedAlbums\.isEmpty\s*\|\|\s*status\s*==\s*\.limited/.test(scan)).toBe(true);
  });

  test('rule 2: a library change under limited access rescans in full', () => {
    const observer = functionBody('photoLibraryDidChange');
    const fullRescanGuard = observer.slice(0, observer.indexOf('spawnScan('));
    expect(/selectedPhotoAlbumIds\.isEmpty/.test(fullRescanGuard)).toBe(true);
    expect(/authorizationStatus\(for:\s*\.readWrite\)\s*==\s*\.limited/.test(fullRescanGuard)).toBe(true);
  });

  test('rule 3: a skipped (missing/unshared) photo does not count toward the failure backoff', () => {
    const batch = functionBody('processBatch');
    // The batch distinguishes three outcomes, not a Bool.
    expect(/withTaskGroup\(of:\s*BatchAssetOutcome\.self\)/.test(batch)).toBe(true);
    expect(/isLocalMissing\(asset\.localAssetId\)\s*\?\s*\.skipped\s*:\s*\.failed/.test(batch)).toBe(true);
    const skipped = batch.slice(batch.indexOf('case .skipped'), batch.indexOf('case .failed'));
    expect(skipped.length).toBeGreaterThan(0);
    expect(/consecutiveFailures/.test(skipped)).toBe(false);
    expect(/backoffUntil/.test(skipped)).toBe(false);
    const failed = batch.slice(batch.indexOf('case .failed'));
    expect(/consecutiveFailures \+= 1/.test(failed)).toBe(true);
  });

  test('the skipped photo is described honestly (not "removed from this iPhone")', () => {
    expect(/Photo removed from this iPhone before backup completed/.test(source)).toBe(false);
    expect(/no longer on this iPhone or no longer shared with Beebeeb/.test(source)).toBe(true);
  });
});
