import type { SyncOp } from './api';

/**
 * True only for a well-formed sync op. The server's SSE stream multiplexes
 * event-bus notifications (`{ type: "file.created", … }` — no seq_id / op_type /
 * payload) with sync ops and documents that clients must ignore non-op
 * messages; applying one as an op read `payload.id` on undefined (task 1305).
 */
export function isSyncOp(value: unknown): value is SyncOp {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<SyncOp>;
  return typeof v.seq_id === 'number' && typeof v.op_type === 'string' && !!v.payload && typeof v.payload === 'object';
}
