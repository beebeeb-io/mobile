// @ts-nocheck — Bun's isolated test runtime types are not part of the app TypeScript project.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

function committedVersionCode() {
  const source = readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8');
  const match = source.match(/\bversionCode\s+(\d+)\b/);
  expect(match).not.toBeNull();
  return Number(match[1]);
}

test('Android local versionCode is a Play-upload-safe integer and matches app.json', () => {
  const versionCode = committedVersionCode();
  expect(Number.isInteger(versionCode)).toBe(true);
  expect(versionCode).toBeGreaterThanOrEqual(8);

  const config = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
  const configuredVersionCode = config.expo?.android?.versionCode;
  if (configuredVersionCode !== undefined) expect(configuredVersionCode).toBe(versionCode);
});

