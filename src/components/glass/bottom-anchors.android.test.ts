// @ts-nocheck — isolated Bun contract guard, task 2233 item 8.
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const source = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const platform = { OS: 'android' };
mock.module('react-native', () => ({ Platform: platform }));
mock.module('react-native-bottom-tabs', () => ({ useBottomTabBarHeight: () => 104 }));
const inset = await import('./tab-bar-inset');

test('one Android rule handles both tab-scene and full-window coordinates; iOS passes through', () => {
  expect(inset.bottomAnchorInset).toBeFunction();
  expect(inset.bottomAnchorInset(0, 116)).toBe(12);
  expect(inset.bottomAnchorInset(24, 116)).toBe(24);
  expect(inset.bottomAnchorInset(48, 116)).toBe(48);
  platform.OS = 'ios';
  for (const legacy of [0, 12, 16, 24, 34, 46, 116]) {
    expect(inset.bottomAnchorInset(48, legacy)).toBe(legacy);
  }
  platform.OS = 'android';
});

// Every window/tab anchored production surface. Each binding must use the
// shared helper; child controls below inherit their parent's inset instead.
const anchors = [
  ['screens/FilesScreen.tsx', /styles\.actionBar, \{ bottom: tabBarBottomInset \}/, /useTabBarBottomInset\(\)/],
  ['screens/FilesScreen.tsx', /styles\.fab, \{ bottom: tabBarBottomInset \+ FAB_BOTTOM_GAP/, /useTabBarBottomInset\(\)/],
  ['screens/FilesScreen.tsx', /bottom=\{tabBarBottomInset \+ FAB_BOTTOM_GAP \+ FAB_SIZE \+ UPLOAD_CARD_GAP_ABOVE_FAB\}/, /useTabBarBottomInset\(\)/],
  ['screens/FilesScreen.tsx', /paddingBottom: bottomAnchorInset\(insets.bottom, Math.max\(insets.bottom, 12\)\)/],
  ['screens/FilesScreen.tsx', /paddingBottom: bottomAnchorInset\(insets.bottom, insets.bottom \|\| 16\)/],
  ['screens/PhotosScreen.tsx', /styles\.bottomOverlay, \{ bottom: tabBarBottomInset \}/, /useTabBarBottomInset\(\)/],
  ['components/BBActionSheet.tsx', /paddingBottom: bottomAnchorInset\(insets.bottom, Math.max\(insets.bottom, 12\)\)/],
  ['components/sheet/BottomSheet.tsx', /const safeBottom = bottomAnchorInset\(insets.bottom, sheetSafeBottom\(insets.bottom\)\)/],
  ['components/FolderPickerModal.tsx', /paddingBottom: bottomAnchorInset\(insets.bottom, insets.bottom \+ 12\)/],
  ['components/EncryptionProof.tsx', /paddingBottom: bottomAnchorInset\(insets.bottom, insets.bottom \|\| spacing.md\)/],
  ['components/preview/DetailsSheet.tsx', /const safeBottom = bottomAnchorInset\(insets.bottom, Math.max\(insets.bottom, 16\)\)/],
  ['screens/PreviewScreen.tsx', /const previewBottomInset = bottomAnchorInset\(insets.bottom, Math.max\(insets.bottom, 16\)\)/, /bottom: previewBottomInset \+ 8/, /bottom: previewBottomInset \+ 76/, /\(\) => previewBottomInset \+ PREVIEW_VIDEO_CONTROLS_BOTTOM_CLEARANCE/],
];
for (const [path, ...bindings] of anchors) {
  test(`bottom anchor uses shared inset: ${path}: ${bindings[0]}`, () => {
    const text = source(path);
    for (const binding of bindings) expect(binding.test(text), `${path}: ${binding}`).toBe(true);
  });
}

const inherited = [
  ['components/ConfirmActionPrompt.tsx', /<BottomSheet\b/],
  ['components/NewFileSheet.tsx', /<BottomSheet\b/],
  ['components/TrustDetailsSheet.tsx', /<BottomSheet\b/],
  ['components/preview/InfoSheet.tsx', /<BottomSheet\b/],
  ['screens/ShareSheetScreen.tsx', /<BottomSheet\b/],
  ['components/preview/PptxRenderer.tsx', /bottom: 16 \+ bottomInset/],
  ['components/UploadActivityCard.tsx', /bottom,/, /bottom: number/],
];
for (const [path, ...bindings] of inherited) {
  test(`inherited bottom anchor: ${path}`, () => {
    for (const binding of bindings) expect(binding.test(source(path)), `${path}: ${binding}`).toBe(true);
  });
}
test('toast and export banner stay in their existing top/in-flow coordinate spaces', () => {
  expect(source('components/Toast.tsx')).toMatch(/top: insets.top \+ 8/);
  expect(source('components/Toast.tsx')).not.toMatch(/\bbottom:/);
  expect(source('components/ExportProgressBanner.tsx')).not.toMatch(/position: ['"]absolute/);
});
