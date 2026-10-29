// @ts-nocheck
// Task 1588 [P0] — iPad (iPhone compatibility mode) QA for App Review.
//
// On an iPad Air 11" (M3), iPadOS 27 (the device App Review used for the
// 2.1(a) rejection, task 1557) this iPhone-only app runs inside a system
// window whose close/minimise/tile controls sit over the window's top-leading
// corner. The plain safe area does NOT include them, so on main (61ddb5b):
//   - every screen title was drawn under the controls ("Drive" read "D…ve");
//   - the preview's Close button (top-left) sat under them, and a tap on it
//     expanded the window controls instead of closing the preview — only the
//     bottom ~20 pt of the button still worked (evidence in
//     .claude/tasks/_qa-evidence/1588/33-*.png).
// The fix lives in native code (SceneDelegate.swift): a UIWindow subclass
// that adds the corner-adapted safe-area difference to the root view
// controller's additionalSafeAreaInsets.top, which every RN screen already
// honours via react-native-safe-area-context.
//
// Same source-text convention as PreviewScreen.webview-parent.test.ts: bun
// test can neither compile Swift nor render these screens, so the source is
// what this guard can check. The behaviour itself was proven on the iPad sim
// (before/after screenshots in the task's evidence folder).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const pluginSceneDelegate = readFileSync(
  join(ROOT, 'plugins/scene-lifecycle/SceneDelegate.swift'),
  'utf-8',
);
const iosSceneDelegate = readFileSync(join(ROOT, 'ios/Beebeeb/SceneDelegate.swift'), 'utf-8');
const trashScreen = readFileSync(join(ROOT, 'src/screens/TrashScreen.tsx'), 'utf-8');

/** The body of `func <name>(` up to the next top-level `func ` / class end. */
function swiftFuncBody(source: string, name: string): string {
  const start = source.indexOf(`func ${name}(`);
  if (start < 0) throw new Error(`func ${name} not found`);
  const next = source.indexOf('\n  func ', start + 1);
  const nextPrivate = source.indexOf('\n  private func ', start + 1);
  const nextOverride = source.indexOf('\n  override func ', start + 1);
  const ends = [next, nextPrivate, nextOverride, source.indexOf('\n}\n', start)].filter((i) => i > 0);
  return source.slice(start, Math.min(...ends));
}

describe('iPad window controls — task 1588', () => {
  test('the committed ios/ copy of SceneDelegate.swift is identical to the plugin source (prebuild copies the plugin file)', () => {
    expect(iosSceneDelegate).toBe(pluginSceneDelegate);
  });

  test('the scene creates a WindowControlsAwareWindow, not a plain UIWindow', () => {
    const connect = swiftFuncBody(pluginSceneDelegate, 'scene');
    expect(connect).toContain('WindowControlsAwareWindow(windowScene: windowScene)');
    expect(connect).not.toMatch(/=\s*UIWindow\(windowScene:/);
  });

  test('the window pushes content below the controls through the root view controller\'s additional safe area', () => {
    const apply = swiftFuncBody(pluginSceneDelegate, 'applyWindowControlsInset');
    // Measured on the WINDOW (self), with vertical corner adaptation — the
    // region that clears the window controls by moving content DOWN.
    expect(apply).toMatch(/[^.]edgeInsets\(for: \.safeArea\(cornerAdaptation: \.vertical\)\)\.top/);
    expect(apply).not.toContain('root.view.edgeInsets');
    expect(apply).toContain('root.additionalSafeAreaInsets.top = extra');
  });

  test('the window re-applies the inset on every layout and safe-area change (rotation, window resize)', () => {
    expect(swiftFuncBody(pluginSceneDelegate, 'layoutSubviews')).toContain('applyWindowControlsInset()');
    expect(swiftFuncBody(pluginSceneDelegate, 'safeAreaInsetsDidChange')).toContain(
      'applyWindowControlsInset()',
    );
  });

  test('the extra inset is the difference between the adapted and plain safe area, never negative', () => {
    const helper = swiftFuncBody(pluginSceneDelegate, 'extraTop');
    expect(helper).toContain('max(0, cornerAdaptedSafeAreaTop - plainSafeAreaTop)');
  });
});

describe('Trash swipe hint sits below the floating header — task 1588', () => {
  test('the hint is the FlatList header (under the chrome), not a normal-flow sibling at y=0', () => {
    const hint = trashScreen.indexOf('Swipe left to restore or permanently delete');
    const listHeader = trashScreen.indexOf('ListHeaderComponent={');
    const flatList = trashScreen.indexOf('<FlatList');
    expect(hint).toBeGreaterThan(-1);
    expect(listHeader).toBeGreaterThan(flatList);
    expect(hint).toBeGreaterThan(listHeader);
  });
});
