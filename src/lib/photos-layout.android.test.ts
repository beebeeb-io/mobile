// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../screens/PhotosScreen.tsx', import.meta.url), 'utf8');
function itemLayout(os: string) {
  const start = src.indexOf('const getItemLayout = useCallback(');
  const end = src.indexOf('\n  const handleViewableItemsChanged', start);
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(src.slice(start, end));
  return new Function('useCallback', 'Platform', 'headerHeight', 'cellSize', 'listItems', 'GRID_GAP', `${js}; return getItemLayout;`)(
    (fn) => fn, { OS: os }, 112, 90, [{ length: 28, offset: 0 }, { length: 92, offset: 28 }], 2,
  );
}
test('Android scroll-to-index includes the measured content inset, preserving iOS geometry', () => {
  expect(itemLayout('android')(null, 1)).toEqual({ length: 92, offset: 140, index: 1 });
  expect(itemLayout('ios')(null, 1)).toEqual({ length: 92, offset: 28, index: 1 });
});
test('Android title fade stays mounted and the full-height list owns its insets', () => {
  expect(src.includes("Platform.OS === 'android' || isScrolled")).toBe(true);
  const list = src.slice(src.indexOf('<FlatList'), src.indexOf('</PinchGestureHandler>'));
  expect(/paddingTop: headerHeight/.test(list)).toBe(true);
  expect(/paddingBottom: tabBarBottomInset \+ bottomOverlayHeight/.test(list)).toBe(true);
  expect(/progressViewOffset=\{Platform.OS === 'android' \? headerHeight : undefined\}/.test(list)).toBe(true);
});
