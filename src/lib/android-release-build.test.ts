// @ts-nocheck — Bun's isolated test runtime types are not part of the app TypeScript project.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
test('release splash images referenced by the native theme exist and are not ignored at every density', () => {
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    const path = `android/app/src/main/res/drawable-${density}/splashscreen_logo.png`;
    expect(existsSync(resolve(root, path))).toBe(true);
    expect(execFileSync('git', ['check-ignore', '--no-index', '--non-matching', '-v', path], { cwd: root, encoding: 'utf8' }))
      .toContain('!android/app/src/main/res/drawable-*/splashscreen_logo.png');
  }
});

test('committed manifest blocks advertising ID from dependency manifest merges', () => {
  const xml = readFileSync(resolve(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  expect(xml).toMatch(/<uses-permission android:name="com\.google\.android\.gms\.permission\.AD_ID" tools:node="remove"\s*\/>/);
});

test('prebuild blocks advertising ID even when a dependency already declares it', () => {
  // Capture and execute the real plugin callback without applying other Expo mods.
  const { createRequire } = require('node:module');
  const isolatedRequire = createRequire(resolve(root, 'package.json'));
  const plugins = isolatedRequire('@expo/config-plugins');
  const original = plugins.withAndroidManifest;
  let callback: any;
  plugins.withAndroidManifest = (config: any, mod: any) => { callback = mod; return config; };
  try {
    isolatedRequire('./plugins/android-security/withAndroidSecurity.js')({});
  } finally {
    plugins.withAndroidManifest = original;
  }
  const config = { modResults: { manifest: {
    application: [{ $: { 'android:allowBackup': 'true' } }],
    'uses-permission': [{ $: { 'android:name': 'com.google.android.gms.permission.AD_ID' } }],
  } } };
  const manifest = callback(config).modResults.manifest;
  expect(manifest['uses-permission'].filter((p: any) => p.$['android:name'] === 'com.google.android.gms.permission.AD_ID'))
    .toEqual([{ $: { 'android:name': 'com.google.android.gms.permission.AD_ID', 'tools:node': 'remove' } }]);
});
