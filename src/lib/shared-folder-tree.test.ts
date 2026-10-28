// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
import { expect, test } from 'bun:test';
import { ancestorsOf, clearTree, ingestTree, subtreeIds } from './shared-folder-tree';
test('ancestors_stop_at_depth_32_and_survive_a_parent_cycle', () => {
  ingestTree(Array.from({ length: 40 }, (_, i) => ({ id: String(i), parent_id: String((i + 1) % 40) })));
  expect(ancestorsOf('0')).toHaveLength(32);
  ingestTree([{ id: 'a', parent_id: 'b' }, { id: 'b', parent_id: 'a' }]);
  expect(ancestorsOf('a')).toEqual(['b']); clearTree(); expect(ancestorsOf('a')).toEqual([]);
});
test('subtreeIds_excludes_trashed_and_request_upload_rows', () => {
  ingestTree([{ id: 'r', parent_id: null }, { id: 'f', parent_id: 'r' }, { id: 't', parent_id: 'r', is_trashed: true }, { id: 'x', parent_id: 'r', file_request_id: 'req' }, { id: 'hidden', parent_id: 't' }]);
  expect(subtreeIds('r')).toEqual(['f']);
});
