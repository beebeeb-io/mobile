// @ts-nocheck — Bun's isolated runner supplies bun:test.
import { expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
const platform = { OS: 'android' };
mock.module('react-native', () => ({ Platform: platform }));
const { deviceNoun, cameraRollNoun } = await import('./device-copy');
const preview = readFileSync(new URL('../screens/PreviewScreen.tsx', import.meta.url), 'utf8');
test('preview routes decrypt, keep-both and deletion wording through device copy', () => {
  expect(preview.includes('Decrypting on ${deviceNoun()}')).toBe(true);
  expect(preview.includes('buildKeepBothName(previewFileName, deviceNoun())')).toBe(true);
  expect(preview.includes('deleted from ${cameraRollNoun()}')).toBe(true);
  expect(preview).not.toContain('Decrypting on iPhone');
});
test('Android copy changes while iOS copy stays byte-for-byte', () => {
  expect(deviceNoun()).toBe('Android');
  expect(cameraRollNoun()).toBe("your phone's gallery");
  platform.OS = 'ios';
  expect(deviceNoun()).toBe('iPhone');
  expect(cameraRollNoun()).toBe('your iPhone camera roll');
});
