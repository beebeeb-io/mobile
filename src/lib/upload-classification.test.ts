// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1959 round 4 — what this device knows about its own uploads' `is_media`.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../services/BackupDatabase', () => ({
  getBackupMediaFlags: async () => { throw new Error('the default lookup is not used in this file'); },
}));

const {
  classifyOwnUploads,
  rememberUploadClassification,
  resetUploadClassificationsForTests,
  UPLOAD_CLASSIFICATION_LIMIT,
} = await import('./upload-classification');
const { advanceAccountEpoch } = await import('./account-epoch');

const noBackup = async () => new Map();

beforeEach(() => resetUploadClassificationsForTests());

describe('upload-classification', () => {
  test('returns the is_media the JS uploader recorded; unknown ids are absent', async () => {
    rememberUploadClassification('img', true);
    rememberUploadClassification('doc', false);
    const out = await classifyOwnUploads(['img', 'doc', 'other'], noBackup);
    expect([...out.entries()].sort()).toEqual([['doc', false], ['img', true]]);
  });

  test('asks the backup table only for ids the JS record lacks, and maps photo/video to true', async () => {
    rememberUploadClassification('js', true);
    const asked = [];
    const out = await classifyOwnUploads(['js', 'cam', 'vid', 'vcf', 'none'], async (ids) => {
      asked.push(...ids);
      return new Map([['cam', true], ['vid', true], ['vcf', false]]);
    });
    expect(asked).toEqual(['cam', 'vid', 'vcf', 'none']);
    expect(Object.fromEntries(out)).toEqual({ js: true, cam: true, vid: true, vcf: false });
  });

  test('a failed backup-table read leaves those ids unknown (never throws)', async () => {
    rememberUploadClassification('js', true);
    const out = await classifyOwnUploads(['js', 'cam'], async () => { throw new Error('sqlite busy'); });
    expect(Object.fromEntries(out)).toEqual({ js: true });
  });

  test('an account-epoch advance (sign-out / sign-in) forgets the record', async () => {
    rememberUploadClassification('img', true);
    advanceAccountEpoch();
    expect((await classifyOwnUploads(['img'], noBackup)).size).toBe(0);
  });

  test('bounded: past the limit the oldest entry goes first', async () => {
    for (let i = 0; i <= UPLOAD_CLASSIFICATION_LIMIT; i += 1) rememberUploadClassification(`f${i}`, true);
    const out = await classifyOwnUploads(['f0', 'f1', `f${UPLOAD_CLASSIFICATION_LIMIT}`], noBackup);
    expect([...out.keys()].sort()).toEqual(['f1', `f${UPLOAD_CLASSIFICATION_LIMIT}`]);
  });
});
