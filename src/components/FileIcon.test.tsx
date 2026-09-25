// @ts-nocheck
// Flow "iOS core journeys" issue 3 (P2) — a locked file's thumbnail was still
// rendered unobscured in the Files row, the Files grid card and the Recent
// tile (all three draw <FileIcon>). Only the full-size preview was gated, so
// anyone holding the unlocked phone could see the image content.
//
// This renders the real FileIcon component (the memo's inner function, called
// directly — its only hooks are the two mocked below) and inspects the element
// tree it returns.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';

const Image = (props: unknown) => props;
const View = (props: unknown) => props;
const Ionicons = (props: unknown) => props;
const IconStub = (props: unknown) => props;

mock.module('react-native', () => ({
  Image,
  View,
  StyleSheet: { create: (s: unknown) => s },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons }));
mock.module('./Icon', () => ({ Icon: IconStub }));
mock.module('../theme', () => ({ radii: { sm: 4, md: 8, lg: 12 } }));
mock.module('../lib/theme-context', () => ({
  useTheme: () => ({
    colors: { amber: '#f6c03a', amberDeep: '#b88400', red: '#c33', green: '#393', ink: '#2a2520', ink2: '#555', ink3: '#777', paper2: '#eee', line: '#ddd' },
  }),
}));

const thumbnailCalls: Array<{ fileId: string; options: Record<string, unknown> }> = [];
mock.module('../lib/use-thumbnail', () => ({
  useThumbnail: (fileId: string, options: Record<string, unknown>) => {
    thumbnailCalls.push({ fileId, options });
    // The decrypted thumbnail is on disk and would be returned for this file
    // whenever the hook is asked for it.
    return { uri: options.enabled ? `file:///cache/beebeeb-thumbnails-v3/${fileId}.medium.webp` : null, source: null, failed: false };
  },
}));

const { FileIcon } = await import('./FileIcon');
const render = (props: Record<string, unknown>) => (FileIcon as unknown as { type: (p: unknown) => React.ReactElement }).type(props);

/** Every element in the returned tree, depth-first. */
function flatten(node: unknown, out: React.ReactElement[] = []): React.ReactElement[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => flatten(n, out));
    return out;
  }
  const el = node as React.ReactElement;
  out.push(el);
  flatten((el.props as { children?: unknown })?.children, out);
  return out;
}

beforeEach(() => {
  thumbnailCalls.length = 0;
});

describe('FileIcon — locked files never show their thumbnail', () => {
  test('an unlocked image with a thumbnail renders the thumbnail Image (control)', () => {
    const tree = flatten(render({ category: 'image', fileId: 'photo-open', hasThumbnail: true }));
    const images = tree.filter((el) => el.type === Image);
    expect(images.length).toBe(1);
    expect(images[0].props.source.uri).toContain('photo-open');
  });

  test('a locked image renders the lock placeholder and no Image source at all', () => {
    const tree = flatten(render({ category: 'image', fileId: 'photo-locked', hasThumbnail: true, locked: true }));
    expect(tree.filter((el) => el.type === Image).length).toBe(0);
    expect(tree.some((el) => el.props?.testID === 'file-icon-locked-photo-locked')).toBe(true);
  });

  test('a locked file never even asks for its thumbnail (no decrypt/load)', () => {
    render({ category: 'image', fileId: 'photo-locked', hasThumbnail: true, locked: true });
    expect(thumbnailCalls.length).toBe(1);
    expect(thumbnailCalls[0].options.enabled).toBe(false);
  });

  test('while the lock list is still loading, no thumbnail is shown either (fail closed), without a lock glyph', () => {
    const tree = flatten(render({ category: 'image', fileId: 'photo-any', hasThumbnail: true, lockStateReady: false }));
    expect(tree.filter((el) => el.type === Image).length).toBe(0);
    expect(tree.some((el) => el.props?.testID === 'file-icon-locked-photo-any')).toBe(false);
    expect(thumbnailCalls[0].options.enabled).toBe(false);
  });
});
