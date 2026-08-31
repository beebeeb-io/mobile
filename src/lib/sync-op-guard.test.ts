// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { isSyncOp } from './sync-op-guard';

describe('isSyncOp', () => {
  test('accepts a well-formed op', () => {
    expect(isSyncOp({ seq_id: 42, op_type: 'folder_create', payload: { id: 'x', parent_id: null }, created_at: 'now' })).toBe(true);
  });
  test('rejects event-bus notifications that share the SSE stream', () => {
    expect(isSyncOp({ type: 'file.created', id: 'x', name_encrypted: '…', parent_id: null, size_bytes: 0 })).toBe(false);
  });
  test('rejects keepalive / junk', () => {
    expect(isSyncOp('keepalive')).toBe(false);
    expect(isSyncOp(null)).toBe(false);
    expect(isSyncOp(undefined)).toBe(false);
    expect(isSyncOp({})).toBe(false);
  });
  test('rejects an op without payload or with a non-numeric seq', () => {
    expect(isSyncOp({ seq_id: 1, op_type: 'file_trash' })).toBe(false);
    expect(isSyncOp({ seq_id: '1', op_type: 'file_trash', payload: { id: 'x' } })).toBe(false);
  });
});
