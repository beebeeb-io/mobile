// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
//
// Task 1947 — the "Encryption details" sheet must never name a storage
// provider (brand/legal rule: name the city, never the hosting company; see
// docs/canon/data-residency.md). The sheet used to render a "Provider" row
// (`loc.provider` from the client-side `trustLocation()` filler). The server
// also serialises `storage_location.provider` on file responses, so this test
// hands the sheet a file whose server location carries a provider string and a
// `trustLocation()` that returns one, and asserts neither reaches the screen.
//
// Drives the real component with react-test-renderer, every dependency mocked
// (ConfirmActionPrompt.test.tsx convention). The positive controls ("Stored
// in", "Algorithm") prove the rows actually rendered, so an empty render can
// never pass as "no provider row".
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const passthrough = (props: Record<string, unknown>) =>
  React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const Text = (props: Record<string, unknown>) => passthrough(props);
const View = (props: Record<string, unknown>) => passthrough(props);
const TouchableOpacity = (props: Record<string, unknown>) => passthrough(props);
const Modal = (props: Record<string, unknown>) => passthrough(props);

mock.module('react-native', () => ({
  View, Text, TouchableOpacity, Modal,
  StyleSheet: { create: (s: unknown) => s },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: () => null }));
mock.module('react-native-gesture-handler', () => ({ GestureHandlerRootView: passthrough }));
mock.module('../theme', () => ({
  fonts: { mono: 'mono', sans: 'sans' },
  onAmber: '#000',
  radii: new Proxy({}, { get: () => 8 }),
  spacing: new Proxy({}, { get: () => 8 }),
}));
mock.module('./sheet/BottomSheet', () => ({
  BottomSheet: (props: Record<string, unknown>) =>
    React.createElement(React.Fragment, null, props.header as React.ReactNode, props.children as React.ReactNode),
  BottomSheetScrollView: passthrough,
}));
mock.module('../lib/theme-context', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

// A provider value in every place one could leak from.
// A sentinel, not a real provider name (the claims guard rightly refuses those in source).
const LEAK = 'StorageCo-1947-sentinel';
mock.module('../lib/api', () => ({
  trustLocation: () => ({ region: 'Europe', place: 'Europe', provider: `${LEAK} trust filler` }),
}));
// storage-regions is NOT mocked: the real country helpers run (task 2050).
mock.module('../lib/file-storage-location', () => ({ useFileStorageLocation: () => null }));
mock.module('../lib/format', () => ({ formatBytes: (n: number) => `${n} B` }));
mock.module('../lib/trust-details', () => ({
  TRUST_ENCRYPTED_ON_LABEL: 'Encrypted on',
  trustEncryptedOnValue: () => 'Your device, before upload',
  trustKeySourceLabel: () => 'Per-file key',
}));
mock.module('./EncryptionProof', () => ({ default: () => null }));

const { default: TrustDetailsSheet } = await import('./TrustDetailsSheet');

const file = {
  id: 'f-1947',
  name_encrypted: 'x',
  size_bytes: 1947,
  created_at: '2026-10-17T19:35:00Z',
  storage_pool_id: 'pool-fsn1',
  // A transition-release server also sends the deprecated `city`: it must never reach the screen.
  storage_location: { country: 'Germany', country_code: 'DE', city: 'Falkenstein', provider: `${LEAK} server field` },
};

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

function renderedTexts(): string[] {
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(TrustDetailsSheet, { file, fileName: 'scan.pdf', onClose: () => {} }),
    );
  });
  return renderer!.root
    .findAll((n) => n.type === Text)
    .map((n) => {
      const c = (n.props as { children?: unknown }).children;
      return Array.isArray(c) ? c.join('') : String(c ?? '');
    });
}

describe('Encryption details sheet names no storage provider (task 1947)', () => {
  test('the sheet renders its rows (positive control)', () => {
    const texts = renderedTexts();
    expect(texts).toContain('Algorithm');
    expect(texts).toContain('Stored in');
    expect(texts).toContain('Germany');
    // The deprecated city next to the country is never rendered (task 2050).
    expect(texts.filter((t) => /Falkenstein/.test(t))).toEqual([]);
  });

  test('there is no "Provider" row', () => {
    const texts = renderedTexts();
    expect(texts.filter((t) => /provider/i.test(t))).toEqual([]);
  });

  test('no provider string from trustLocation() or storage_location reaches the screen', () => {
    const texts = renderedTexts();
    expect(texts.filter((t) => t.includes(LEAK))).toEqual([]);
  });

  test('the sheet source reads no provider field', () => {
    const source = readFileSync(join(import.meta.dir, 'TrustDetailsSheet.tsx'), 'utf-8');
    expect(/\.provider\b/.test(source)).toBe(false);
    expect(/label="Provider"/.test(source)).toBe(false);
  });
});
