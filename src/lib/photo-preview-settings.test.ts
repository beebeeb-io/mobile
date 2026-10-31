// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let prefs: Record<string, unknown> = {};
let strictError: Error | null = null;
const setCalls: Array<[string, unknown]> = [];
mock.module('./api', () => ({
  getPreferenceValue: async (key: string) => prefs[key] ?? null,
  getPreferenceValueStrict: async (key: string) => { if (strictError) throw strictError; return prefs[key] ?? null; },
  setPreferenceValue: async (key: string, value: unknown) => { setCalls.push([key, value]); prefs[key] = value; },
}));

const s = await import('./photo-preview-settings');
beforeEach(() => { strictError = null; prefs = {}; setCalls.length = 0; });

describe('parsePhotoPreviewSetting', () => {
  test('accepts a valid value', () => {
    expect(s.parsePhotoPreviewSetting({ enabled: true, format: 'jpeg', px: 1920 })).toEqual({ enabled: true, format: 'jpeg', px: 1920 });
  });
  test('garbage gives the default', () => {
    for (const raw of [null, undefined, 5, 'x', [], { enabled: 'yes', format: 'png', px: 100 }]) {
      expect(s.parsePhotoPreviewSetting(raw)).toEqual(s.DEFAULT_PHOTO_PREVIEW_SETTING);
    }
  });
  test('partial keeps valid fields and defaults the rest', () => {
    expect(s.parsePhotoPreviewSetting({ enabled: true })).toEqual({ enabled: true, format: 'heic', px: 2560 });
    expect(s.parsePhotoPreviewSetting({ px: 3840, format: 'bmp' })).toEqual({ enabled: false, format: 'heic', px: 3840 });
  });
});

test('size options are labelled in order', () => {
  expect(s.PREVIEW_SIZE_OPTIONS).toEqual([
    { label: '720p', px: 1280 }, { label: '1080p', px: 1920 }, { label: '2K', px: 2560 }, { label: '4K', px: 3840 },
  ]);
});

describe('previewTargetSize', () => {
  test('downsizes landscape', () => expect(s.previewTargetSize(6000, 4000, 2560)).toEqual({ width: 2560, height: 1707 }));
  test('never upscales', () => expect(s.previewTargetSize(1000, 800, 3840)).toEqual({ width: 1000, height: 800 }));
  test('portrait', () => expect(s.previewTargetSize(3000, 6000, 1920)).toEqual({ width: 960, height: 1920 }));
});

describe('load/save', () => {
  test('load defaults when unset or unparsable', async () => {
    expect(await s.loadPhotoPreviewSetting()).toEqual(s.DEFAULT_PHOTO_PREVIEW_SETTING);
    prefs.photo_previews = '{not json';
    expect(await s.loadPhotoPreviewSetting()).toEqual(s.DEFAULT_PHOTO_PREVIEW_SETTING);
  });
  test('load reads an object-valued preference, and a JSON string too', async () => {
    prefs.photo_previews = { enabled: true, format: 'jpeg', px: 3840 };
    expect(await s.loadPhotoPreviewSetting()).toEqual({ enabled: true, format: 'jpeg', px: 3840 });
    prefs.photo_previews = JSON.stringify({ enabled: true, format: 'heic', px: 1920 });
    expect(await s.loadPhotoPreviewSetting()).toEqual({ enabled: true, format: 'heic', px: 1920 });
  });
  test('save sends an object value', async () => {
    await s.savePhotoPreviewSetting({ enabled: true, format: 'jpeg', px: 1280 });
    expect(setCalls[0][1]).toEqual({ enabled: true, format: 'jpeg', px: 1280 });
  });
  test('save then load round-trips under the photo_previews key', async () => {
    await s.savePhotoPreviewSetting({ enabled: true, format: 'jpeg', px: 1280 });
    expect(setCalls[0][0]).toBe('photo_previews');
    expect(await s.loadPhotoPreviewSetting()).toEqual({ enabled: true, format: 'jpeg', px: 1280 });
  });
});

describe('loadPhotoPreviewSettingStrict', () => {
  test('unset gives the default', async () => {
    expect(await s.loadPhotoPreviewSettingStrict()).toEqual(s.DEFAULT_PHOTO_PREVIEW_SETTING);
  });
  test('reads a stored value', async () => {
    prefs.photo_previews = { enabled: true, format: 'jpeg', px: 3840 };
    expect(await s.loadPhotoPreviewSettingStrict()).toEqual({ enabled: true, format: 'jpeg', px: 3840 });
  });
  test('a failed read throws instead of answering the default', async () => {
    strictError = new Error('offline');
    await expect(s.loadPhotoPreviewSettingStrict()).rejects.toThrow('offline');
  });
});
