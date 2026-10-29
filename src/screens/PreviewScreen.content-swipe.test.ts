// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1687b — swipe-down on preview CONTENT closes the preview.
//
// The dismiss pan used to be attached ONLY to the header rows (media +
// doc). Content — the pager pages and the single-file stage — had no pan,
// so the only way out of an image was hunting for the close button.
// Same source-text convention as PreviewScreen.chrome-layer.test.ts.
// Mutation evidence in task 1687 Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf-8');

/** Grab the balanced JSX region starting at an exact offset. */
function region(from: number, length = 4000): string {
  return source.slice(from, from + length);
}

describe('task 1687b — a content-area pan dismisses the preview', () => {
  test('one PanGestureHandler wraps ALL media content branches (pager + locked single + stage)', () => {
    const showPagerIdx = source.indexOf('{showPager ? (');
    expect(showPagerIdx).toBeGreaterThan(0);
    const before = region(Math.max(0, showPagerIdx - 1600), 1600);
    // The wrapper must sit between the last chrome content and the ternary.
    const wrapperStart = before.lastIndexOf('<PanGestureHandler');
    expect(wrapperStart).toBeGreaterThanOrEqual(0);
    const wrapper = before.slice(wrapperStart) + region(showPagerIdx, 200);
    expect(wrapper).toContain('onGestureEvent={onCloseGestureEvent}');
    expect(wrapper).toContain('onHandlerStateChange={onCloseHandlerStateChange}');
    expect(wrapper).toContain('enabled={!mediaZoomed}');
    // Same activation shape as the header pan (drives the same thresholds).
    expect(wrapper).toContain('activeOffsetY={[-1000, 8]}');
    expect(wrapper).toContain('failOffsetX={[-20, 20]}');
  });

  test('the pan closes after the media content ternary (it wraps the whole block)', () => {
    const handlerIdx = source.indexOf('<PanGestureHandler', source.indexOf('{showPager ? (') - 1600);
    const after = region(handlerIdx, 26000);
    const closing = after.indexOf('</PanGestureHandler>');
    expect(closing).toBeGreaterThan(0);
    // Between the wrapper's open and close, the locked single-file stage and
    // the normal stage Pressable must both appear — i.e. the pan really
    // wraps content, not just one branch.
    const wrapped = after.slice(0, closing);
    expect(wrapped).toContain('testID="preview-locked-single"');
    expect(wrapped).toContain('testID="preview-content-tap"');
    expect(wrapped).toContain('testID="preview-content-tap"'.length > 0 ? 'onMomentumScrollEnd={handlePagerScroll}' : '');
  });

  test('the header swipe-to-close pans are unchanged (media + doc)', () => {
    const pans = [...source.matchAll(/<PanGestureHandler[\s\S]{0,400}?>/g)].map((m) => m[0]);
    const headerPans = pans.filter((p) => p.includes('onCloseHandlerStateChange'));
    expect(headerPans.length).toBeGreaterThanOrEqual(3); // media header + content + doc header
  });
});