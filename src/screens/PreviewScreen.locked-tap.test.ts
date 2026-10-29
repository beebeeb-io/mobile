// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1687a — locked-preview taps register: no dead zones.
//
// Pre-1687a, a VAULT-locked (isUnlocked=false — a different lock from the
// per-file Face ID gate) pager page had NO dedicated render branch: it fell
// through to the content branch's plain status View, whose only tap path
// was the pager FlatList's raw onTouchStart/onTouchEnd detector (10 pt /
// 500 ms window) — an imprecise or slow tap landed nowhere. That is the
// "sometimes doesn't respond to touch, no menu top or bottom, specifically
// when locked" report behind task 1687.
//
// Same source-text convention as PreviewScreen.chrome-layer.test.ts: bun
// test cannot render this screen, so the JSX shape is what this guard
// checks. Mutation evidence in task 1687 Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');
const chromeSource = readFileSync(join(import.meta.dir, '../lib/preview-chrome.ts'), 'utf-8');

describe('task 1687a — locked pager pages have a real tap affordance', () => {
  test('PhotoPage decides the tap action through the unit-tested pagerTapAction', () => {
    expect(chromeSource).toMatch(/export function pagerTapAction/);
    expect(source).toMatch(/pagerTapAction\(\{ fileLocked: locked, vaultLocked: !isUnlocked, contentOwned: false \}\)/);
  });

  test('a dedicated VAULT-locked page branch exists and toggles chrome (no auth step)', () => {
    expect(source).toMatch(/testID="preview-vault-locked-page"/);
    // The branch is gated on the vault lock, not the file lock.
    expect(source).toMatch(/action === 'toggle-chrome' && !isUnlocked/);
    // Hit-testing responsiveness only: the vault-locked card must NOT
    // present any authenticate affordance (task 1684 owns the unlock flow).
    expect(source).not.toMatch(/preview-vault-locked-page[\s\S]{0,900}authenticateAsync/);
  });

  test('both locked page branches stop raw touch propagation (no double-toggle with the pager detector)', () => {
    // The pager's FlatList onTouchStart/onTouchEnd detector would otherwise
    // see the Pressable's bubbled touch and call handleContentTap a second
    // time — two chrome toggles cancel out and the tap reads as dead again.
    const wrapperCount = [...source.matchAll(/onTouchStart=\{stopPageTouchPropagation\}/g)].length;
    expect(wrapperCount).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/const stopPageTouchPropagation = \(e: GestureResponderEvent\) => \{\s*e\.stopPropagation\(\);/);
  });

  test('the file-locked page keeps its authenticate affordance (1539, unchanged)', () => {
    expect(source).toMatch(/testID="preview-locked-page"/);
    expect(source).toMatch(/onPress=\{\(\) => onRequestUnlock\(entry\.id\)\}/);
    expect(source).toMatch(/disabled=\{unlocking\}/);
  });
});