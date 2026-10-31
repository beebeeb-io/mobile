// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  applyConfirmMessage,
  photoPreviewStorageLine,
  rebuildConfirmMessage,
  turnOffConfirmMessage,
} from './photo-preview-copy';

const base = { sizeLabel: '4K', format: 'heic', storageBytes: 9_000_000, onWifi: false, skipped: 0 };

describe('Apply confirmation', () => {
  test('lists what happens, with the real size, format and storage, and the data clause off Wi-Fi', () => {
    expect(applyConfirmMessage(base)).toBe([
      '• Each photo gets a new 4K HEIC preview, made from the original on this iPhone.',
      '• Your current previews stay until each new one is ready.',
      '• Your original photos are not touched.',
      '• Keep Beebeeb open until it finishes. If you close it, it continues where it left off next time.',
      '• Uses about 9 MB of your Beebeeb storage; uses mobile data unless you are on Wi-Fi.',
    ].join('\n'));
  });

  test('on Wi-Fi the data clause is left out', () => {
    expect(applyConfirmMessage({ ...base, onWifi: true })).toContain('• Uses about 9 MB of your Beebeeb storage.');
    expect(applyConfirmMessage({ ...base, onWifi: true })).not.toContain('mobile data');
  });

  test('unknown storage keeps the data clause on its own; skipped photos get the existing sentence', () => {
    const m = applyConfirmMessage({ ...base, storageBytes: null, skipped: 4, format: 'jpeg', sizeLabel: '720p' });
    expect(m).toContain('new 720p JPEG preview');
    expect(m).toContain('• It uses mobile data unless you are on Wi-Fi.');
    expect(m).not.toContain('Beebeeb storage');
    expect(m.endsWith('4 photos that are not on this iPhone are skipped; they get a preview the first time you open them here.')).toBe(true);
  });
});

describe('Rebuild confirmation', () => {
  test('the same list plus the time, data and battery warning', () => {
    const m = rebuildConfirmMessage(base);
    expect(m).toContain('• Your current previews stay until each new one is ready.');
    expect(m).toContain('• Replaces about 9 MB of previews. Your Beebeeb storage use stays about the same.');
    expect(m).not.toContain('Uses about');
    expect(m).toContain('• Rebuilding takes a while and uses battery. It uses mobile data unless you are on Wi-Fi.');
  });
});

describe('Turn off confirmation', () => {
  test('with and without the amount', () => {
    expect(turnOffConfirmMessage(9_000_000)).toBe([
      "• Deletes all previews from your Beebeeb storage and this iPhone, about 9 MB. You can't undo this, but you can make them again later.",
      '• Your original photos are not touched.',
    ].join('\n'));
    expect(turnOffConfirmMessage(null)).toContain('and this iPhone. You can');
    expect(turnOffConfirmMessage(0)).toContain('and this iPhone. You can');
  });
});

describe('Storage screen line', () => {
  test('shown with a count, hidden at 0 or without support', () => {
    expect(photoPreviewStorageLine({ count: 13, total_bytes: 9_000_000, by_setting: [] })).toBe('Photo previews: 9 MB');
    expect(photoPreviewStorageLine({ count: 0, total_bytes: 0, by_setting: [] })).toBeNull();
    expect(photoPreviewStorageLine(null)).toBeNull();
  });
});
