// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1689 — light-mode header fade at rest on Photos.
//
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

describe('task 1689 — Photos header blur is gated on real scroll state', () => {
  test('ScrollEdgeBlur mounts only when isScrolled is true', () => {
    expect(source).toMatch(/\{\s*isScrolled\s*\?\s*<ScrollEdgeBlur/);
  });

  test('no unconditional ScrollEdgeBlur mount remains', () => {
    // A bare `<ScrollEdgeBlur` NOT preceded by the isScrolled ternary would
    // reintroduce the at-rest fade this task removes.
    const bareMounts = [...source.matchAll(/<(ScrollEdgeBlur)\b/g)].filter((m) => {
      const before = source.slice(Math.max(0, m.index - 40), m.index);
      return !/isScrolled\s*\?\s*$/.test(before);
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