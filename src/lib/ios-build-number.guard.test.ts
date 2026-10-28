// @ts-nocheck — Bun's isolated test runtime types are not part of the app TypeScript project.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// This tree ships prebuilt (`ios/` is committed), so EAS ignores
// `app.json` -> `expo.ios.buildNumber` and the number that actually lands in the
// IPA is the literal `CFBundleVersion` in `ios/Beebeeb/Info.plist`
// (DEVIATIONS.md, task 2234: "the build number must be bumped by hand").
// Bumping only app.json silently ships the previous build number — the upload is
// then rejected as a duplicate build, or the wrong binary is signed off.
const root = resolve(import.meta.dir, '../..');

function appJsonIosBuildNumber() {
  const config = JSON.parse(readFileSync(resolve(root, 'app.json'), 'utf8'));
  const buildNumber = config?.expo?.ios?.buildNumber;
  return buildNumber === undefined ? undefined : String(buildNumber);
}

function infoPlistBundleVersion() {
  const plist = readFileSync(resolve(root, 'ios/Beebeeb/Info.plist'), 'utf8');
  return plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
}

test('the committed Info.plist carries an integer CFBundleVersion', () => {
  const bundleVersion = infoPlistBundleVersion();
  expect(bundleVersion).toBeDefined();
  expect(/^\d+$/.test(bundleVersion ?? '')).toBe(true);
});

test('app.json ios.buildNumber matches the CFBundleVersion that ships', () => {
  expect(appJsonIosBuildNumber()).toBe(infoPlistBundleVersion());
});
