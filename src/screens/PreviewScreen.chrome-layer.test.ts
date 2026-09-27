// @ts-nocheck
// Regression guard: dead close/⋯ buttons in the single-file preview (found by
// the sim219 verification lane, 2026-09-27, task 1579 notes).
//
// Root cause: #123 (1563) wrapped the media header in an opacity-fade
// `<Animated.View>` but left `position:'absolute'` + `zIndex:20` on the inner
// `mediaHeader` row. zIndex only orders SIBLINGS, and the wrapper — the
// header's only link to the content stage — was a zero-height, un-z-indexed
// normal-flow view rendered BEFORE the stage. The single-file stage is a
// `Pressable`, so it sat on top of the header and took every tap (the tap just
// toggled the chrome), and the zero-frame ancestor chain dropped the controls
// from the accessibility tree. The photo pager escaped only because its stage
// is a plain layout `View` that Fabric flattens away.
//
// Same source-text convention as PreviewScreen.webview-parent.test.ts: bun
// test has no React reconciler here, so the JSX shape is the only thing this
// guard can check. Mutation evidence is in task 1579's Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');

function styleObjectBody(styleName: string): string {
  const re = new RegExp(`\\n  ${styleName}\\s*:\\s*\\{([^}]*)\\}`, 's');
  const m = source.match(re);
  if (!m) throw new Error(`style "${styleName}" not found in source`);
  return m[1];
}

/** The opening tag of the `<Animated.View` that directly wraps each header's
 * swipe-to-close PanGestureHandler (one per branch: media, doc). */
function headerWrapperTags(): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf('onGestureEvent={onCloseGestureEvent}', from);
    if (at === -1) break;
    const open = source.lastIndexOf('<Animated.View', at);
    const close = source.indexOf('>\n', source.indexOf('pointerEvents=', open));
    tags.push(source.slice(open, close + 1));
    from = at + 1;
  }
  return tags;
}

describe('PreviewScreen top chrome — floats above the content and stays tappable', () => {
  test('both branches (media + doc) have a header wrapper', () => {
    expect(headerWrapperTags().length).toBe(2);
  });

  test('chromeLayer is absolute with a zIndex above the content', () => {
    const body = styleObjectBody('chromeLayer');
    expect(body).toMatch(/position:\s*'absolute'/);
    expect(body).toMatch(/top:\s*0/);
    const z = Number(body.match(/zIndex:\s*(\d+)/)?.[1] ?? 0);
    expect(z).toBeGreaterThanOrEqual(20);
  });

  test('every header wrapper — the sibling of the content stage — carries chromeLayer', () => {
    for (const tag of headerWrapperTags()) {
      expect(tag).toContain('styles.chromeLayer');
    }
  });

  test('the header rows themselves are in-flow (an absolute row zeroes the wrapper frame)', () => {
    for (const name of ['mediaHeader', 'header']) {
      expect(styleObjectBody(name)).not.toMatch(/position:\s*'absolute'/);
    }
  });
});
