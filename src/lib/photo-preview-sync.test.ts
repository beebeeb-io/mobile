// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let nativeCalls: any[][] = [];
let loadImpl: () => Promise<any>;

mock.module('../../modules/beebeeb-crypto', () => ({
  setPhotoPreviewSetting: (...a: any[]) => { nativeCalls.push(a); },
}));
mock.module('./photo-preview-settings', () => ({
  DEFAULT_PHOTO_PREVIEW_SETTING: { enabled: false, format: 'heic', px: 2560 },
  loadPhotoPreviewSettingStrict: () => loadImpl(),
  parsePhotoPreviewSetting: (v: any) => ({
    enabled: v.enabled === true, format: v.format === 'jpeg' ? 'jpeg' : 'heic', px: [1280, 1920, 2560, 3840].includes(v.px) ? v.px : 2560,
  }),
}));

const { setExpectedUserId } = await import('./expected-user');
const { advanceAccountEpoch } = await import('./account-epoch');
const {
  mirrorPhotoPreviewSetting, syncPhotoPreviewSettingToNative, loadSettingForScreen, applyPreferenceUpdateOp,
  onPhotoPreviewSettingChange, getSessionPhotoPreviewSetting, __resetPhotoPreviewSyncForTests,
} = await import('./photo-preview-sync');

let loads = 0;
beforeEach(() => {
  nativeCalls = [];
  loads = 0;
  loadImpl = async () => { loads += 1; return { enabled: true, format: 'jpeg', px: 1920 }; };
  advanceAccountEpoch();
  setExpectedUserId('acct-1');
  __resetPhotoPreviewSyncForTests();
});

describe('photo preview native mirror', () => {
  test('mirror passes the setting through, including Off', () => {
    mirrorPhotoPreviewSetting({ enabled: false, format: 'heic', px: 2560 });
    expect(nativeCalls).toEqual([[false, 'heic', 2560, 'acct-1']]);
  });

  test('sync loads the account setting and mirrors it', async () => {
    await syncPhotoPreviewSettingToNative();
    expect(nativeCalls).toEqual([[true, 'jpeg', 1920, 'acct-1']]);
  });

  test('sync never throws and leaves native alone when loading fails', async () => {
    loadImpl = async () => { throw new Error('offline'); };
    await syncPhotoPreviewSettingToNative();
    expect(nativeCalls).toEqual([]);
  });

  test('an unset preference mirrors the default (Off)', async () => {
    loadImpl = async () => ({ enabled: false, format: 'heic', px: 2560 });
    await syncPhotoPreviewSettingToNative();
    expect(nativeCalls).toEqual([[false, 'heic', 2560, 'acct-1']]);
  });

  test('screen load: a failed read is "failed" and does not touch native', async () => {
    loadImpl = async () => { throw new Error('offline'); };
    expect(await loadSettingForScreen()).toEqual({ status: 'failed' });
    expect(nativeCalls).toEqual([]);
  });

  test('screen load: a stored setting is returned and mirrored', async () => {
    expect(await loadSettingForScreen()).toEqual({ status: 'loaded', setting: { enabled: true, format: 'jpeg', px: 1920 } });
    expect(nativeCalls).toEqual([[true, 'jpeg', 1920, 'acct-1']]);
  });
});

describe('account scope', () => {
  test('the mirror names the account; an explicit id (sign-in, still locked) wins', async () => {
    setExpectedUserId(null);
    await syncPhotoPreviewSettingToNative('acct-9');
    expect(nativeCalls).toEqual([[true, 'jpeg', 1920, 'acct-9']]);
    // Later mirrors in the same session reuse it while the vault is still locked.
    mirrorPhotoPreviewSetting({ enabled: false, format: 'heic', px: 2560 });
    expect(nativeCalls[1][3]).toBe('acct-9');
  });

  test('no account known: mirrored for nobody (native treats it as disabled)', () => {
    setExpectedUserId(null);
    mirrorPhotoPreviewSetting({ enabled: true, format: 'heic', px: 2560 });
    expect(nativeCalls).toEqual([[true, 'heic', 2560, null]]);
  });

  test('a sign-out drops the remembered account', async () => {
    await syncPhotoPreviewSettingToNative('acct-9');
    advanceAccountEpoch();
    setExpectedUserId(null);
    mirrorPhotoPreviewSetting({ enabled: true, format: 'heic', px: 2560 });
    expect(nativeCalls.at(-1)[3]).toBeNull();
  });
});

describe('preference_update sync op', () => {
  test('photo_previews is mirrored natively and reaches listeners', () => {
    const seen: any[] = [];
    onPhotoPreviewSettingChange((s) => seen.push(s));
    expect(applyPreferenceUpdateOp({ key: 'photo_previews', value: { enabled: true, format: 'jpeg', px: 1280 } })).toBe(true);
    expect(nativeCalls).toEqual([[true, 'jpeg', 1280, 'acct-1']]);
    expect(seen).toEqual([{ enabled: true, format: 'jpeg', px: 1280 }]);
  });

  test('a JSON string value is accepted too', () => {
    expect(applyPreferenceUpdateOp({ key: 'photo_previews', value: '{"enabled":false,"format":"heic","px":2560}' })).toBe(true);
    expect(nativeCalls).toEqual([[false, 'heic', 2560, 'acct-1']]);
  });

  test('other keys and bad values are ignored', () => {
    expect(applyPreferenceUpdateOp({ key: 'theme', value: { enabled: true } })).toBe(false);
    expect(applyPreferenceUpdateOp({ key: 'photo_previews', value: 'not json' })).toBe(false);
    expect(applyPreferenceUpdateOp({ key: 'photo_previews', value: null })).toBe(false);
    expect(nativeCalls).toEqual([]);
  });
});

describe('session setting (viewer)', () => {
  test('read once, then served from memory; a mirror updates it', async () => {
    expect(await getSessionPhotoPreviewSetting()).toEqual({ enabled: true, format: 'jpeg', px: 1920 });
    await getSessionPhotoPreviewSetting();
    expect(loads).toBe(1);
    applyPreferenceUpdateOp({ key: 'photo_previews', value: { enabled: false, format: 'heic', px: 2560 } });
    expect(await getSessionPhotoPreviewSetting()).toEqual({ enabled: false, format: 'heic', px: 2560 });
    expect(loads).toBe(1);
  });

  test('a failed read answers Off and is not cached; a sign-out forgets the value', async () => {
    loadImpl = async () => { loads += 1; throw new Error('offline'); };
    expect((await getSessionPhotoPreviewSetting()).enabled).toBe(false);
    loadImpl = async () => { loads += 1; return { enabled: true, format: 'heic', px: 3840 }; };
    expect((await getSessionPhotoPreviewSetting()).px).toBe(3840);
    advanceAccountEpoch();
    loadImpl = async () => { loads += 1; return { enabled: false, format: 'heic', px: 2560 }; };
    expect((await getSessionPhotoPreviewSetting()).enabled).toBe(false);
    expect(loads).toBe(3);
  });
});
