// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
/**
 * SF-0002 M2a: `fileWriteState` derives a tri-state write verdict from the
 * name convention plus the classified content version. Unknown is never
 * writable; the content half survives a move (same objectVersionId) and dies
 * on lock, account switch, or a new objectVersionId.
 */
import { beforeEach, expect, test } from 'bun:test';
import {
  clearWriteState, fileWriteState, noteObjectVersion, overwriteAllowed,
  recordContentConvention, recordNameConvention, renameAllowed,
} from './sf-0002-write-state';

beforeEach(() => { clearWriteState(); });

test('an_unknown_file_is_not_writable', () => {
  expect(fileWriteState('f')).toBe('unknown');
  expect(overwriteAllowed('f')).toBe(false);
  expect(renameAllowed('f')).toBe(false);
});

test('a_canonical_cached_row_is_writable_for_rename', () => {
  // A batch name hit carries `string_or_binary`; rename needs only the name half.
  recordNameConvention('f', 'string_or_binary');
  expect(renameAllowed('f')).toBe(true);
  // Content has not been classified yet: rename stays allowed, overwrite not.
  expect(fileWriteState('f')).toBe('unknown');
  expect(overwriteAllowed('f')).toBe(false);
});

test('a_row_classified_string_allows_overwrite', () => {
  recordNameConvention('f', 'string_or_binary');
  recordContentConvention('f', 'v1', 'string');
  expect(fileWriteState('f')).toBe('writable');
  expect(overwriteAllowed('f')).toBe(true);
  expect(renameAllowed('f')).toBe(true);
});

test('an_upper_repair_name_is_read_only_with_zero_content_requests', () => {
  recordNameConvention('f', 'upper_repair');
  expect(fileWriteState('f')).toBe('read_only');
  expect(overwriteAllowed('f')).toBe(false);
  expect(renameAllowed('f')).toBe(false);
});

test('an_upper_repair_content_version_is_read_only', () => {
  recordNameConvention('f', 'string_or_binary');
  recordContentConvention('f', 'v1', 'upper_repair');
  expect(fileWriteState('f')).toBe('read_only');
  expect(overwriteAllowed('f')).toBe(false);
  expect(renameAllowed('f')).toBe(true);
});

test('a_binary_name_with_ambiguous_content_is_writable', () => {
  recordNameConvention('f', 'binary');
  recordContentConvention('f', 'v1', 'string_or_binary');
  expect(fileWriteState('f')).toBe('writable');
});

test('a_move_with_the_same_objectVersionId_keeps_the_content_half', () => {
  recordNameConvention('f', 'string_or_binary');
  recordContentConvention('f', 'v1', 'string');
  noteObjectVersion('f', 'v1');
  expect(fileWriteState('f')).toBe('writable');
});

test('a_new_objectVersionId_resets_the_content_half_to_unknown', () => {
  recordNameConvention('f', 'string_or_binary');
  recordContentConvention('f', 'v1', 'string');
  noteObjectVersion('f', 'v2');
  expect(fileWriteState('f')).toBe('unknown');
  expect(overwriteAllowed('f')).toBe(false);
  // Rename still only needs the name half.
  expect(renameAllowed('f')).toBe(true);
});

test('an_unknown_content_classification_is_not_cached', () => {
  recordNameConvention('f', 'string_or_binary');
  recordContentConvention('f', 'v1', 'unknown');
  expect(fileWriteState('f')).toBe('unknown');
});

test('a_lock_or_account_switch_resets_every_verdict', () => {
  recordNameConvention('f', 'string_or_binary');
  recordContentConvention('f', 'v1', 'string');
  expect(fileWriteState('f')).toBe('writable');
  clearWriteState();
  expect(fileWriteState('f')).toBe('unknown');
  const src = require('node:fs').readFileSync(new URL('./shared-folder-keys.ts', import.meta.url), 'utf8');
  expect(src).toContain('clearWriteState()');
});
