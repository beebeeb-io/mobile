// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Tasks 1689/2233 — iOS fade remains scroll-gated; Android title fade stays mounted.
//
// 2233: Android now keeps the gradient mounted; the iOS invariant below stays.
// ScrollEdgeBlur is the progressive blur strip under the top chrome. Every
// sibling screen gates it on `isScrolled` (FilesScreen 4545, SettingsScreen
// 1826, TrashScreen 386, SharedScreen 737, StorageScreen 403,
// BackupInsightsScreen 629); PhotosScreen alone mounted it UNCONDITIONALLY,
// so in light mode its 0.30-alpha light tint rendered as a visible
// "plain-band fade" over the grid's paper background at rest — the "rare
// fade" Guus reported. Same source-text convention as
// PreviewScreen.chrome-layer.test.ts: bun test has no React reconciler here,
// so the JSX shape is the only thing this guard can check.
//
// The gate is only honest if the native grid (iOS, no scroll event of its
// own) can actually FLIP `isScrolled` — so this file also pins the
// `onVisiblePhotoIdsChange`-based derivation that replaces the dead
// FlatList-only wiring 1322 described.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PhotosScreen.tsx'), 'utf-8');

describe('tasks 1689/2233 — platform-specific Photos header fade', () => {
  test('iOS keeps its scroll gate; Android also shows the title gradient at rest', () => {
    const match = source.match(/\{\s*(Platform.OS === 'android' \|\| isScrolled)\s*\?\s*<ScrollEdgeBlur/);
    expect(match).not.toBeNull();
    const visible = new Function('Platform', 'isScrolled', `return ${match![1]};`);
    expect(visible({ OS: 'ios' }, false)).toBe(false);
    expect(visible({ OS: 'ios' }, true)).toBe(true);
    expect(visible({ OS: 'android' }, false)).toBe(true);
    expect(visible({ OS: 'android' }, true)).toBe(true);
  });

  test('no unconditional iOS ScrollEdgeBlur mount remains', () => {
    const bareMounts = [...source.matchAll(/<(ScrollEdgeBlur)\b/g)].filter((m) => {
      const before = source.slice(Math.max(0, m.index - 80), m.index);
      return !/Platform.OS === 'android' \|\| isScrolled\s*\?\s*$/.test(before);
    });
    expect(bareMounts).toEqual([]);
  });

  test('the native grid derives isScrolled from visible photo ids (top-photo heuristic)', () => {
    // The iOS grid emits no scroll event; the blur gate must be driven by
    // the visible-ids callback (topmost photo leaves the visible set ⇒
    // scrolled) or `isScrolled` stays false forever and the blur never
    // appears — 1322's original objection, still true without this.
    expect(source).toMatch(/handleNativeVisibleIdsChange[\s\S]{0,1600}nextIsScrolled/);
    expect(source).toMatch(/const nextIsScrolled = !visibleIds\.has\(topPhotoId\)/);
  });

  test('the FlatList fallback keeps its own onScroll derivation', () => {
    expect(source).toMatch(/const handleGridScroll = useCallback\(\(e: \{ nativeEvent: \{ contentOffset: \{ y: number \} \} \}\) => \{[\s\S]{0,200}contentOffset\.y > 0/);
    expect(source).toMatch(/onScroll=\{handleGridScroll\}/);
  });
});