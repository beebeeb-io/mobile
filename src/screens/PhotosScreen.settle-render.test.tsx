// @ts-nocheck
/**
 * Task 2233 item 1 (A7, adversarial case 9) — a viewport settle where no
 * cell's thumbnail id changed must render 0 PhotoCells.
 *
 * The real `PhotoRow`/`PhotoCell` (src/screens/photos/photo-grid-row.tsx) are
 * rendered with react-test-renderer. The row receives the per-row thumbnail
 * signature PhotosScreen's `renderItem` now computes, so a settle that only
 * changes OTHER rows leaves this row's memo intact and its `<ThumbnailImage>`s
 * are not re-rendered.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const renders = new Map<string, number>();
function bump(id: string): void {
  renders.set(id, (renders.get(id) ?? 0) + 1);
}

const host = (name: string) => (props: any) => React.createElement(name, props, props.children);

mock.module('react-native', () => ({
  View: host('View'),
  TouchableOpacity: host('TouchableOpacity'),
  StyleSheet: { create: (s: any) => s, absoluteFill: {}, hairlineWidth: 1 },
}));
mock.module('@expo/vector-icons', () => ({ Ionicons: host('Ionicons') }));
mock.module('../components/Icon', () => ({ Icon: host('Icon') }));
mock.module('../components/ThumbnailImage', () => ({
  ThumbnailImage: (props: any) => {
    bump(String(props.fileId));
    return React.createElement('ThumbnailImage', props);
  },
}));
mock.module('../lib/locked-thumbnail', () => ({
  lockAwareThumbnailFields: (_id: string, fields: any) => ({
    localAssetId: fields.localAssetId,
    blurhash: fields.blurhash,
    hideThumbnail: false,
    isLocked: false,
  }),
}));
mock.module('../lib/photo-candidates', () => ({ mediaMimeType: () => 'image/jpeg' }));
mock.module('../lib/theme-context', () => ({
  useTheme: () => ({ colors: { paper2: '#fff', ink: '#000', ink3: '#999', amber: '#fc0' } }),
}));

const { PhotoRow, thumbnailSignatureForRow } = await import('./photos/photo-grid-row');

function entry(id: string) {
  return { id, has_thumbnail: true, parent_id: 'folder', blurhash: null } as any;
}

const rowA = [entry('a1'), entry('a2')];
const rowB = [entry('b1')];

// Stable identities, as in PhotosScreen (state/callbacks that do not change
// on a viewport settle). A fresh object per render would defeat every memo.
const shared = {
  photosFolderId: null,
  localAssetMap: new Map<string, string>(),
  decryptedNames: {},
  decryptedMimeTypes: {},
  onThumbnailUnavailable: () => {},
  onOpenPhoto: () => {},
  onTogglePhoto: () => {},
  onLongPressPhoto: () => {},
  selectedIds: new Set<string>(),
  selectMode: false,
  columns: 4,
  cellSize: 100,
  lockedIds: new Set<string>(),
  lockStateReady: true,
};

function Harness({ active }: { active: Set<string> }) {
  return (
    <>
      <PhotoRow {...shared} photos={rowA} seedOffset={0} thumbnailSignature={thumbnailSignatureForRow(rowA, active)} />
      <PhotoRow {...shared} photos={rowB} seedOffset={10} thumbnailSignature={thumbnailSignatureForRow(rowB, active)} />
    </>
  );
}

describe('task 2233 A7 — settle render hygiene', () => {
  beforeEach(() => {
    renders.clear();
  });

  test('case 9: changing another row\'s active ids renders 0 PhotoCells in an unchanged row', async () => {
    const first = new Set(['a1']);
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(<Harness active={first} />);
    });
    const aAfterMount = renders.get('a1')! + renders.get('a2')!;
    const bAfterMount = renders.get('b1')!;
    expect(aAfterMount).toBe(2);
    expect(bAfterMount).toBe(1);

    // A new Set (what flushPendingViewport produces) whose only new member is
    // in row B. Row A's signature is unchanged.
    const second = new Set(['a1', 'b1']);
    await act(async () => {
      renderer.update(<Harness active={second} />);
    });
    expect(renders.get('a1')! + renders.get('a2')!).toBe(aAfterMount);
    expect(renders.get('b1')!).toBe(bAfterMount + 1);

    // Control: a settle that DOES change row A renders its cells (the counter
    // can detect renders — the assertion above is not vacuous).
    const third = new Set(['a1', 'a2', 'b1']);
    await act(async () => {
      renderer.update(<Harness active={third} />);
    });
    expect(renders.get('a1')! + renders.get('a2')!).toBe(aAfterMount + 1);
  });

  test('the per-row signature is stable for identical membership', () => {
    expect(thumbnailSignatureForRow(rowA, new Set(['a1']))).toBe(
      thumbnailSignatureForRow(rowA, new Set(['a1', 'b1'])),
    );
    expect(thumbnailSignatureForRow(rowA, new Set(['a1', 'a2']))).not.toBe(
      thumbnailSignatureForRow(rowA, new Set(['a1'])),
    );
  });
});
