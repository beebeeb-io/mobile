// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 2050 — the upload activity card names a COUNTRY (or "Europe"), never a
// city: "-> Europe" while the server has not named the file's country, then
// "Stored in Germany · key stayed here". Drives the real component with
// react-test-renderer, every dependency mocked (TrustDetailsSheet.no-provider
// convention). The positive control proves the data line actually rendered.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const passthrough = (props: Record<string, unknown>) =>
  React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const Text = (props: Record<string, unknown>) => passthrough(props);
const View = (props: Record<string, unknown>) => passthrough(props);

mock.module('react-native', () => ({
  View, Text,
  StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: () => null }));
mock.module('../lib/theme-context', () => ({ useTheme: () => ({ resolved: 'light' }) }));
mock.module('../theme', () => ({
  colors: new Proxy({}, { get: () => '#111' }),
  darkColors: new Proxy({}, { get: () => '#eee' }),
  fonts: { mono: 'mono', sans: 'sans' },
}));
mock.module('./glass', () => ({
  GLASS_RADII: new Proxy({}, { get: () => 12 }),
  GlassSurface: passthrough,
  glassMaterial: () => ({ label: '#000', labelMuted: '#666' }),
}));

const { UploadActivityCard } = await import('./UploadActivityCard');

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function lines(upload): string[] {
  act(() => {
    renderer = TestRenderer.create(React.createElement(UploadActivityCard, { upload, bottom: 0 }));
  });
  return renderer!.root
    .findAll((n) => n.type === Text)
    .map((n) => {
      const c = (n.props as { children?: unknown }).children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
}

const base = { fileName: 'a.pdf', percent: 40, region: 'Europe' };

describe('upload activity card (task 2050)', () => {
  test('uploading: the data line points at the place the server has named, a country', () => {
    const texts = lines({ ...base, stage: 2, place: 'Germany' });
    expect(texts.some((t) => t.includes('→ Germany'))).toBe(true);
  });

  test('uploading before the country is known: "Europe", never a city', () => {
    const texts = lines({ ...base, stage: 2, place: 'Europe' });
    expect(texts.some((t) => t.includes('→ Europe'))).toBe(true);
  });

  test('storing: names the place', () => {
    expect(lines({ ...base, stage: 3, place: 'Finland' })).toContain('Storing in Finland…');
  });

  test('done: "Stored in <country> · key stayed here"', () => {
    expect(lines({ ...base, stage: 'done', percent: 100, place: 'Germany' })).toContain('Stored in Germany · key stayed here');
  });

  test('the card source reads no city field', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(import.meta.dir, 'UploadActivityCard.tsx'), 'utf8');
    expect(/\.city\b|\bcity:/.test(src)).toBe(false);
  });
});
