/**
 * Task 2237c, decision L7c (plan C): shared-folder custody is one-way per account.
 *
 * The server is untrusted. The format a client uses for a shared folder's child wraps
 * follows custody (L7b): a folder WITH a custody record is L7 for every read and write, a
 * folder WITHOUT one (a flag-off invite) stays on the legacy reader. If that decision were
 * remade from the custody GET on every call, a server could answer 404 (or 405/501) for a
 * folder the client already opened and flip it back to the legacy, unbound reader.
 *
 * So the first time this account has seen a folder's custody record AND opened it under the
 * L6 key, the fact is recorded durably, before the folder key is used. From then on:
 *   - a 404/405/501 for that folder, or a 200 whose record no longer opens, is an ERROR
 *     (`CustodyUnavailableError`, "This folder's keys are unavailable"), never "legacy";
 *   - no fresh random folder key is minted over it (`assertMayRegisterCustody`): L1 says a
 *     client mints only when the server has no record, and a downgrading server would say so.
 * A folder this account never saw custody for keeps the L7b behaviour: 404/405/501 = legacy.
 * An unreadable or unwritable memory is never read as "never seen": it refuses.
 *
 * Storage: SecureStore (this device only), one record per account under a key made from a
 * 64-bit digest of the account id (not the id), holding folder ids only; a small index of
 * account digests lets the sign-out sweep find every record (SecureStore cannot list keys).
 * `clearCustodyMemory()` is called by the sign-out purge; the in-memory copy is also dropped on
 * every account-epoch advance, and a write that outlives its epoch is discarded. Another
 * account never reads this one's record: the key is derived from the account asking.
 *
 * Call sites (the resolver, the publisher and link creation live in the C2/C3 PRs):
 *   - after `GET /shared-folders/{id}` returns a record that opens: `await memory.markSeen(...)`
 *     BEFORE registering the folder handle;
 *   - on 404/405/501 (`isCustodyAbsentStatus`) or a 200 that does not open:
 *     `await settleMissingCustody(...)` — 'legacy' or a thrown refusal;
 *   - before minting + registering custody: `await assertMayRegisterCustody(...)`;
 *   - every key write for a custody folder: `withL7Format(body)`;
 *   - a 409 on any key write: `toUpgradeRequired(error)` is the honest "the owner must
 *     upgrade this folder" state, never a retry as legacy.
 */

import * as SecureStore from 'expo-secure-store';
import { onAccountEpochAdvance, StaleAccountError } from './account-epoch';

const INDEX_KEY = 'beebeeb.custody-seen.v1.index';
const RECORD_PREFIX = 'beebeeb.custody-seen.v1.';
// 5,000 folders is ~190 KB; past that the memory would rather refuse than forget.
const MAX_FOLDERS_PER_ACCOUNT = 5000;
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export class CustodyUnavailableError extends Error {
  constructor() {
    super("This folder's keys are unavailable");
    this.name = 'CustodyUnavailableError';
  }
}

export class UpgradeRequiredError extends Error {
  constructor() {
    // Not "upgrade": the App Store scan (task 1821) treats that word as purchase vocabulary.
    super('The owner must convert this folder first');
    this.name = 'UpgradeRequiredError';
  }
}

/** 404/405/501 on the custody GET: no custody record (L7b/L7c), or a server pretending so. */
export function isCustodyAbsentStatus(status: unknown): boolean {
  return status === 404 || status === 405 || status === 501;
}

/** 409 `upgrade_required` on a key write; any other error is not this state. */
export function toUpgradeRequired(error: unknown): UpgradeRequiredError | null {
  const e = error as { status?: unknown; code?: unknown } | null;
  return e && typeof e === 'object' && e.status === 409 && e.code === 'upgrade_required'
    ? new UpgradeRequiredError()
    : null;
}

/** `format: "l7"` on every custody-folder key write, and only there (contract 2237 §1). */
export function withL7Format<T extends object>(body: T): T & { format: 'l7' } {
  const format = (body as { format?: unknown }).format;
  if (format !== undefined && format !== 'l7') throw new Error('Key writes carry format "l7" only');
  return { ...body, format: 'l7' };
}

export interface CustodyStorePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const secureStoreCustodyPort: CustodyStorePort = {
  get: key => SecureStore.getItemAsync(key, STORE_OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, STORE_OPTIONS),
  delete: key => SecureStore.deleteItemAsync(key, STORE_OPTIONS),
};

export interface CustodyMemory {
  /** True once this account has seen and opened the folder's custody. Refuses when unprovable. */
  hasSeen(accountId: string | null, folderId: string): Promise<boolean>;
  /** Durable, idempotent. Resolves only after the record is stored. */
  markSeen(accountId: string | null, folderId: string): Promise<void>;
  /** Sign-out: every account's record, memory and store. Best effort; a leftover is only ever read by its own account. */
  clearAll(): Promise<void>;
}

function fnv1a32(bytes: Uint8Array, offsetBasis: number): string {
  let hash = offsetBasis >>> 0;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 16 hex digits to recognise the account on this device without storing its id. Not a secret. */
function accountKey(accountId: string | null): string {
  if (!accountId) throw new CustodyUnavailableError();
  const bytes = new TextEncoder().encode(`beebeeb-custody-seen:${accountId}`);
  return fnv1a32(bytes, 0x811c9dc5) + fnv1a32(bytes, 0x050c5d1f);
}

function folderKey(folderId: string): string {
  if (typeof folderId !== 'string' || folderId.length === 0) throw new CustodyUnavailableError();
  return folderId.toLowerCase();
}

function parseStringList(raw: string, field: 'folders' | 'accounts'): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CustodyUnavailableError(); }
  const list = (value as Record<string, unknown> | null)?.[field];
  if ((value as { v?: unknown } | null)?.v !== 1 || !Array.isArray(list) || !list.every(item => typeof item === 'string')) {
    throw new CustodyUnavailableError();
  }
  return list as string[];
}

export function createCustodyMemory(store: CustodyStorePort): CustodyMemory {
  let generation = 0;
  const cache = new Map<string, Set<string>>();
  let queue: Promise<unknown> = Promise.resolve();
  onAccountEpochAdvance(() => { generation += 1; cache.clear(); });

  // Read-modify-write and the sweep take turns, so a late write cannot undo a sign-out sweep.
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(key: string): Promise<Set<string>> {
    const cached = cache.get(key);
    if (cached) return cached;
    const started = generation;
    let raw: string | null;
    try { raw = await store.get(RECORD_PREFIX + key); } catch { throw new CustodyUnavailableError(); }
    const ids = new Set(raw === null ? [] : parseStringList(raw, 'folders'));
    if (started === generation) cache.set(key, ids);
    return ids;
  }

  async function indexedAccounts(): Promise<string[]> {
    try {
      const raw = await store.get(INDEX_KEY);
      return raw === null ? [] : parseStringList(raw, 'accounts');
    } catch { return []; }
  }

  return {
    async hasSeen(accountId, folderId) {
      const key = accountKey(accountId), id = folderKey(folderId);
      return (await load(key)).has(id);
    },
    async markSeen(accountId, folderId) {
      const key = accountKey(accountId), id = folderKey(folderId);
      const started = generation;
      return serial(async () => {
        const known = await load(key);
        if (started !== generation) throw new StaleAccountError('custody memory');
        if (known.has(id)) return;
        if (known.size >= MAX_FOLDERS_PER_ACCOUNT) throw new CustodyUnavailableError();
        const next = new Set(known).add(id);
        try {
          const accounts = new Set(await indexedAccounts()).add(key);
          if (started !== generation) throw new StaleAccountError('custody memory');
          // Index first: an index entry without a record is harmless, the reverse would hide it from the sweep.
          await store.set(INDEX_KEY, JSON.stringify({ v: 1, accounts: [...accounts].sort() }));
          await store.set(RECORD_PREFIX + key, JSON.stringify({ v: 1, folders: [...next].sort() }));
        } catch (error) {
          throw error instanceof StaleAccountError ? error : new CustodyUnavailableError();
        }
        cache.set(key, next);
      });
    },
    clearAll() {
      return serial(async () => {
        cache.clear();
        for (const key of await indexedAccounts()) await store.delete(RECORD_PREFIX + key).catch(() => undefined);
        await store.delete(INDEX_KEY).catch(() => undefined);
      });
    },
  };
}

/**
 * The folder's custody is missing or unusable. Never seen: 'legacy' (L7b). Seen before: refuse (L7c).
 * Throws `CustodyUnavailableError` when the memory cannot answer, so doubt never reads as legacy.
 */
export async function settleMissingCustody(memory: CustodyMemory, accountId: string | null, folderId: string): Promise<'legacy'> {
  if (await memory.hasSeen(accountId, folderId)) throw new CustodyUnavailableError();
  return 'legacy';
}

/** Mint-and-register path: never over a folder whose custody this account has seen. */
export async function assertMayRegisterCustody(memory: CustodyMemory, accountId: string | null, folderId: string): Promise<void> {
  if (await memory.hasSeen(accountId, folderId)) throw new CustodyUnavailableError();
}

export const custodyMemory: CustodyMemory = createCustodyMemory(secureStoreCustodyPort);

/** Sign-out purge hook (`account-cleanup.ts`). */
export function clearCustodyMemory(): Promise<void> {
  return custodyMemory.clearAll();
}
