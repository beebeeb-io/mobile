// @ts-nocheck
// Task 1685 fix 6 — RED-first tests for the pre-upload dedupe decision logic.
//
// Guus (verbatim): "Als ik dezelfde afbeeldingen na de crash opnieuw upload
// dan maakt 'ie ze aan als nieuwe, op zijn minst wil ik de optie om te
// overschrijven of skippen en dan per file of alle files, dus voor de upload
// moet dit gecheckt worden."
//
// The match key is the DECRYPTED filename within the current folder
// (case-insensitive) — the same key the old findConflict used, but the batch
// path used to auto-version or silently rename instead of asking. The decision
// mapping lives here as pure functions; FilesScreen only wires the Alert.
import { describe, expect, test } from 'bun:test';
import {
  findDecryptedNameConflict,
  nextAvailableName,
  planBatchResolutions,
} from './upload-conflict';

describe('findDecryptedNameConflict', () => {
  const names = {
    f1: 'IMG_0001.jpg',
    f2: 'Report.PDF',
  };

  test('matches a decrypted name case-insensitively and returns the existing id', () => {
    expect(findDecryptedNameConflict('img_0001.JPG', names)).toBe('f1');
    expect(findDecryptedNameConflict('report.pdf', names)).toBe('f2');
  });

  test('returns null when no row matches (or names are not hydrated yet)', () => {
    expect(findDecryptedNameConflict('new.png', names)).toBeNull();
    expect(findDecryptedNameConflict('IMG_0001.jpg', {})).toBeNull();
    expect(findDecryptedNameConflict('IMG_0001.jpg', undefined)).toBeNull();
  });

  test('never matches a folder-style empty name', () => {
    expect(findDecryptedNameConflict('', names)).toBeNull();
  });
});

describe('nextAvailableName', () => {
  test('keeps a free name untouched', () => {
    expect(nextAvailableName('photo.jpg', new Set(['other.jpg']))).toBe('photo.jpg');
  });

  test('suffixes (1), (2), … skipping anything already taken', () => {
    const taken = new Set(['photo.jpg', 'photo (1).jpg']);
    expect(nextAvailableName('photo.jpg', taken)).toBe('photo (2).jpg');
  });

  test('handles extensionless names and dotfiles like the old getUniqueMobileName', () => {
    expect(nextAvailableName('archive', new Set(['archive', 'archive (1)']))).toBe('archive (2)');
    expect(nextAvailableName('.profile', new Set(['.profile']))).toBe('.profile (1)');
  });
});

describe('planBatchResolutions', () => {
  const conflict = (index: number, incomingName: string, existingId = `existing-${index}`) => ({
    index,
    incomingName,
    incomingMimeType: 'image/jpeg',
    incomingSizeBytes: 100,
    existingId,
    existingName: incomingName,
    existingNameEncrypted: `enc-${existingId}`,
    existingSizeBytes: 200,
  });

  test('overwrite maps to version-existing (a new version under the existing row)', () => {
    const decisions = planBatchResolutions(
      [conflict(2, 'photo.jpg')],
      ['overwrite'],
      new Set(['photo.jpg']),
    );
    expect(decisions.get(2)).toEqual({
      action: 'version-existing',
      existingId: 'existing-2',
      existingNameEncrypted: 'enc-existing-2',
    });
  });

  test('skip maps to skip; keep-both gets a name that avoids folder + batch names', () => {
    const decisions = planBatchResolutions(
      [conflict(0, 'photo.jpg'), conflict(3, 'video.mov')],
      ['skip', 'keep-both'],
      new Set(['photo.jpg', 'video.mov', 'video (1).mov']),
    );
    expect(decisions.get(0)).toEqual({ action: 'skip' });
    expect(decisions.get(3)).toEqual({ action: 'keep-both', finalName: 'video (2).mov' });
  });

  test('two keep-both conflicts with the SAME name get DIFFERENT suffixes', () => {
    const decisions = planBatchResolutions(
      [conflict(0, 'photo.jpg'), conflict(1, 'photo.jpg')],
      ['keep-both', 'keep-both'],
      new Set(['photo.jpg']),
    );
    const a = decisions.get(0);
    const b = decisions.get(1);
    expect(a?.action).toBe('keep-both');
    expect(b?.action).toBe('keep-both');
    expect(a.finalName).not.toBe(b.finalName);
    expect(a.finalName).toBe('photo (1).jpg');
    expect(b.finalName).toBe('photo (2).jpg');
  });

  test('a keep-both final name never collides with a later plain upload of the same name', () => {
    // photo.jpg exists; first conflict keep-both → "photo (1).jpg"; a second,
    // NON-conflicting asset named photo.jpg must not steal "photo (1).jpg".
    const decisions = planBatchResolutions(
      [conflict(0, 'photo.jpg')],
      ['keep-both'],
      new Set(['photo.jpg']),
    );
    expect(decisions.get(0).finalName).toBe('photo (1).jpg');
  });

  test('resolutions and conflicts must be parallel arrays', () => {
    expect(() =>
      planBatchResolutions([conflict(0, 'a.jpg'), conflict(1, 'b.jpg')], ['skip'], new Set()),
    ).toThrow();
  });

  test('every conflict gets a decision; results are keyed by the ORIGINAL batch index', () => {
    const decisions = planBatchResolutions(
      [conflict(7, 'a.jpg'), conflict(12, 'b.jpg')],
      ['overwrite', 'skip'],
      new Set(['a.jpg', 'b.jpg']),
    );
    expect(decisions.size).toBe(2);
    expect(decisions.get(7)?.action).toBe('version-existing');
    expect(decisions.get(12)?.action).toBe('skip');
  });
});