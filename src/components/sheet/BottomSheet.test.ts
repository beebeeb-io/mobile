// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1586 — the shared bottom sheet: full width + the draggable handle.
//
// Source-text guards (bun has no React Native reconciler here — same
// convention as PreviewScreen.info-sheet.test.ts). The detent math itself is
// unit-tested in src/lib/sheet-detents.test.ts. Mutation evidence is in task
// 1586's Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, 'BottomSheet.tsx'), 'utf-8');

function styleBlock(name: string): string {
  const m = src.match(new RegExp(`\\n  ${name}:\\s*\\{([^}]*)\\}`, 's'));
  if (!m) throw new Error(`style "${name}" not found`);
  return m[1];
}

describe('BottomSheet geometry — full width (Guus, build 221)', () => {
  test('left / right / bottom 0, no horizontal margin', () => {
    const s = styleBlock('sheet');
    expect(s).toMatch(/position:\s*'absolute'/);
    expect(s).toMatch(/\bleft:\s*0,/);
    expect(s).toMatch(/\bright:\s*0,/);
    expect(s).toMatch(/\bbottom:\s*0,/);
    expect(s).not.toMatch(/margin(Horizontal|Left|Right)\s*:/);
  });

  test('top corners at GLASS_RADII.sheet, bottom corners square', () => {
    const s = styleBlock('sheet');
    expect(s).not.toMatch(/\bborderRadius:/);
    expect(s).toMatch(/borderTopLeftRadius:\s*GLASS_RADII\.sheet,/);
    expect(s).toMatch(/borderTopRightRadius:\s*GLASS_RADII\.sheet,/);
    expect(s).toMatch(/borderBottomLeftRadius:\s*0,/);
    expect(s).toMatch(/borderBottomRightRadius:\s*0,/);
  });

  test('the only runtime override of the edges is the keyboard height on bottom', () => {
    const at = src.indexOf('sheetStyles.sheet,');
    const inline = src.slice(at, src.indexOf('testID={testID}', at));
    expect(inline).not.toMatch(/\b(left|right):/);
    expect(inline).toMatch(/bottom: keyboardHeight,/);
  });

  test('the home-indicator inset is padding INSIDE the sheet', () => {
    expect(src).toMatch(/return Math\.max\(insetBottom, 16\);/);
    expect(src).toMatch(/const safeBottom = sheetSafeBottom\(insets\.bottom\);/);
    expect(src).toMatch(/const bottomPad = keyboardHeight > 0 \? 8 : safeBottom;/);
    expect(src).toMatch(/paddingBottom: bottomPad \+ restHidden,/);
  });
});

describe('BottomSheet — draggable by the handle (Guus, build 221)', () => {
  test('the handle row and the header are inside the pan target', () => {
    const pan = src.indexOf('onGestureEvent={onHandleGesture}');
    const close = src.indexOf('</PanGestureHandler>', pan);
    expect(pan).toBeGreaterThan(-1);
    const target = src.slice(pan, close);
    expect(target).toContain('sheetStyles.handleRow');
    expect(target).toContain('{header ?');
  });

  test('the finger drives the sheet on the native driver', () => {
    expect(src).toMatch(/Animated\.event\(\[\{ nativeEvent: \{ translationY: drag \} \}\], \{ useNativeDriver: true \}\)/);
    expect(src).toMatch(/Animated\.spring\(base, \{[^}]*useNativeDriver: true/s);
    expect(src).toMatch(/transform: \[\{ translateY \}\]/);
  });

  test('only an ACTIVE gesture stops a running spring (sim: a stray BEGAN froze the sheet between detents)', () => {
    expect(src).toMatch(/if \(state === State\.ACTIVE\) beginDrag\(\);/);
    expect(src).not.toMatch(/state === State\.BEGAN\) beginDrag/);
  });

  test('a release goes through the detent math (nearest by position + velocity, dismiss)', () => {
    expect(src).toMatch(/resolveSheetSnap\(\{ visibleHeight: shown, velocityY, detents \}\)/);
    expect(src).toMatch(/if \(snap\.kind === 'dismiss'\) \{\s*close\(velocityY\);\s*onRequestClose\(\);/);
  });

  test('past the tallest detent the sheet is rubber-banded', () => {
    expect(src).toMatch(/pos\.interpolate\(\{ \.\.\.rubberBandInterpolation\(sheetHeight, closedY\)/);
    expect(src).toMatch(/displayedTranslate\(raw, sheetHeight\)/);
  });

  test('content scrolls at every detent; at its top a pull hands over to the sheet', () => {
    // the hidden part of the sheet is padded out of the scroll frame
    expect(src).toMatch(/setRestHidden\(target >= closedY \? 0 : target\)/);
    // the content pan runs alongside the scroll view
    expect(src).toMatch(/simultaneousHandlers=\{innerRef\}/);
    expect(src).toMatch(/simultaneousHandlers=\{ctx\.contentPanRef\}/);
    // … and only takes over when the scroll view is at its top, pulling down
    expect(src).toMatch(/if \(scrollYRef\.current > 0\.5 \|\| translationY <= 0\) return;/);
    expect(src).toMatch(/bounces=\{false\}/);
  });

  test('VoiceOver: the handle is adjustable, with a label and a spoken detent', () => {
    const at = src.indexOf('style={sheetStyles.handleRow}');
    const tag = src.slice(at, src.indexOf('>', at));
    expect(tag).toContain('accessibilityRole="adjustable"');
    expect(tag).toContain('accessibilityLabel={handleAccessibilityLabel}');
    expect(tag).toMatch(/accessibilityValue=\{\{ text: detentAccessibilityValue\(/);
    expect(tag).toContain("{ name: 'increment' }, { name: 'decrement' }");
    expect(tag).toContain('onAccessibilityAction={onHandleAccessibilityAction}');
    expect(src).toMatch(/adjustDetent\(indexRef\.current, name, detents\.length\)/);
  });
});
