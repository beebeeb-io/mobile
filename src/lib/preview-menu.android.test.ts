// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../screens/PreviewScreen.tsx', import.meta.url), 'utf8');
test('Android and iOS open app options while web keeps its existing Alert', () => {
  const start = src.indexOf('const handlePreviewOptions =');
  const end = src.indexOf('// Swipe pager:', start);
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(src.slice(start, end));
  for (const os of ['android', 'ios', 'web']) {
    const events: string[] = [];
    const handle = new Function('useCallback', 'Platform', 'setInfoVisible', 'setOptionsVisible', 'Alert', 'previewActions', 'previewFileName', `${js}; return handlePreviewOptions;`)(
      (fn) => fn, { OS: os }, () => events.push('info-closed'),
      () => events.push('app-options'), { alert: () => events.push('alert') }, [], '2233.jpg',
    );
    handle();
    expect(events).toEqual(['info-closed', os === 'web' ? 'alert' : 'app-options']);
  }
});
test('Android options reuse the themed sheet; iOS retains its popover', () => {
  const popover = src.slice(src.indexOf('function PreviewOptionsPopover('), src.indexOf('// Styles', src.indexOf('function PreviewOptionsPopover(')));
  expect(/Platform.OS === 'android'[\s\S]*<BBActionSheet/.test(popover)).toBe(true);
  expect(popover.includes('visible={visible}')).toBe(true);
  expect(popover.includes('destructive: action.destructive')).toBe(true);
  expect(popover.includes('onPress: action.run')).toBe(true);
  expect(popover.includes('styles.optionsPanel')).toBe(true);
});

test('Android Modal gives the sheet gestures their own native root', () => {
  const sheet = readFileSync(new URL('../components/BBActionSheet.tsx', import.meta.url), 'utf8');
  expect(sheet.includes("Platform.OS === 'android' ? GestureHandlerRootView : View")).toBe(true);
  expect(sheet.includes('<SheetRoot style={styles.fill}>')).toBe(true);
});
