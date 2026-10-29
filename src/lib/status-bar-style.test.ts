// @ts-nocheck
// Task 1591 bug 1 — the status bar's content style must follow the surface it
// sits on. Pure logic + a source guard that PreviewScreen actually wires it
// (bun test has no React reconciler here; same convention as
// PreviewScreen.chrome-layer.test.ts). Mutation evidence: task 1591 Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewSurfaceIsDark, statusBarStyleFor } from './status-bar-style';

const base = {
  isMediaPreview: false,
  isText: false,
  editMode: false,
  textLoaded: false,
  isMarkdown: false,
  showSource: false,
};

describe('statusBarStyleFor', () => {
  test('light content on a dark background, dark content on a light one', () => {
    expect(statusBarStyleFor(true)).toBe('light');
    expect(statusBarStyleFor(false)).toBe('dark');
  });
});

describe('previewSurfaceIsDark — both themes', () => {
  for (const appScheme of ['light', 'dark'] as const) {
    test(`photo/video/RAW stage is dark (app theme ${appScheme})`, () => {
      expect(previewSurfaceIsDark({ ...base, isMediaPreview: true, appScheme })).toBe(true);
      expect(statusBarStyleFor(previewSurfaceIsDark({ ...base, isMediaPreview: true, appScheme }))).toBe('light');
    });
    test(`text editor is dark (app theme ${appScheme})`, () => {
      expect(previewSurfaceIsDark({ ...base, isText: true, editMode: true, appScheme })).toBe(true);
    });
    test(`loaded code / plain text (CodeRenderer) is dark (app theme ${appScheme})`, () => {
      expect(previewSurfaceIsDark({ ...base, isText: true, textLoaded: true, appScheme })).toBe(true);
    });
    test(`markdown "Show source" is dark (app theme ${appScheme})`, () => {
      expect(previewSurfaceIsDark({ ...base, isText: true, textLoaded: true, isMarkdown: true, showSource: true, appScheme })).toBe(true);
    });
  }

  test('rendered markdown, documents and loading states follow the app theme', () => {
    const md = { ...base, isText: true, textLoaded: true, isMarkdown: true };
    expect(previewSurfaceIsDark({ ...md, appScheme: 'light' })).toBe(false);
    expect(previewSurfaceIsDark({ ...md, appScheme: 'dark' })).toBe(true);
    expect(previewSurfaceIsDark({ ...base, appScheme: 'light' })).toBe(false);
    expect(previewSurfaceIsDark({ ...base, appScheme: 'dark' })).toBe(true);
    // text still loading → the themed c.paper root is what shows
    expect(previewSurfaceIsDark({ ...base, isText: true, appScheme: 'light' })).toBe(false);
  });
});

describe('PreviewScreen wires the surface-aware style', () => {
  const source = readFileSync(join(import.meta.dir, '../screens/PreviewScreen.tsx'), 'utf-8');

  test('every <StatusBar> in PreviewScreen passes style={statusBarStyle}', () => {
    const tags = source.match(/<StatusBar\b[^>]*\/>/g) ?? [];
    expect(tags.length).toBe(2);
    for (const tag of tags) expect(tag).toContain('style={statusBarStyle}');
  });

  test('statusBarStyle comes from previewSurfaceIsDark', () => {
    expect(source).toMatch(/const surfaceIsDark = previewSurfaceIsDark\(/);
    expect(source).toMatch(/const statusBarStyle = statusBarStyleFor\(surfaceIsDark\)/);
  });

  test('the doc header top scrim darkens over a dark surface', () => {
    expect(source).toMatch(/<PreviewTopScrim[^>]*dark=\{surfaceIsDark\}/);
  });
});
