/**
 * Task 2237c, decisions L7c, L10 and L11 (plan C; contract-2237-format-l7.md §1 and §2):
 * shared-folder custody is one-way per account.
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
 * L11: a folder the server answered 409 `upgrade_required` on (it already has key rows and no
 * custody) is never minted over either; only the owner's upgrade gives it custody. That state is
 * recorded the same way (`noteUpgradeRequired`) and ends when custody is later seen and opened.
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
 *   - every key write for a custody folder: `withL7Format(body)` (L10);
 *   - a 409 on any key write or on registering custody: `noteUpgradeRequired(...)` is the honest
 *     "the owner must convert this folder first" state (L11), never a retry as legacy.
 */

import { onAccountEpochAdvance, StaleAccountError } from './account-epoch';

const INDEX_KEY = 'beebeeb.custody-seen.v1.index';
const RECORD_PREFIX = 'beebeeb.custody-seen.v1.';
// 5,000 folders is ~190 KB; past that the memory would rather refuse than forget.
const MAX_FOLDERS_PER_ACCOUNT = 5000;
interface AccountRecord { folders: Set<string>; upgrade: Set<string> }

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

// Loaded on first use: the resolver and publisher import this module, and their tests must not
// need a native SecureStore mock just to load it.
async function secureStore() {
  const store = await import('expo-secure-store');
  return { store, options: { keychainAccessible: store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY } };
}

export const secureStoreCustodyPort: CustodyStorePort = {
  get: async key => { const { store, options } = await secureStore(); return store.getItemAsync(key, options); },
  set: async (key, value) => { const { store, options } = await secureStore(); await store.setItemAsync(key, value, options); },
  delete: async key => { const { store, options } = await secureStore(); await store.deleteItemAsync(key, options); },
};

export interface CustodyMemory {
  /** True once this account has seen and opened the folder's custody. Refuses when unprovable. */
  hasSeen(accountId: string | null, folderId: string): Promise<boolean>;
  /** Durable, idempotent. Resolves only after the record is stored. Ends an `upgrade_required` mark. */
  markSeen(accountId: string | null, folderId: string): Promise<void>;
  /** True while the server's last word on this folder was 409 `upgrade_required` (L11). */
  isUpgradeRequired(accountId: string | null, folderId: string): Promise<boolean>;
  /** Durable, idempotent: this folder needs the owner's upgrade, never a fresh custody. */
  markUpgradeRequired(accountId: string | null, folderId: string): Promise<void>;
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

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(item => b.has(item));
}

function parseList(value: unknown, field: string, required: boolean): string[] {
  const list = (value as Record<string, unknown> | null)?.[field];
  if (list === undefined && !required) return [];
  if (!Array.isArray(list) || !list.every(item => typeof item === 'string')) throw new CustodyUnavailableError();
  return list as string[];
}

function parseJson(raw: string): unknown {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CustodyUnavailableError(); }
  if ((value as { v?: unknown } | null)?.v !== 1) throw new CustodyUnavailableError();
  return value;
}

export function createCustodyMemory(store: CustodyStorePort): CustodyMemory {
  let generation = 0;
  const cache = new Map<string, AccountRecord>();
  let queue: Promise<unknown> = Promise.resolve();
  onAccountEpochAdvance(() => { generation += 1; cache.clear(); });

  // Read-modify-write and the sweep take turns, so a late write cannot undo a sign-out sweep.
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(key: string): Promise<AccountRecord> {
    const cached = cache.get(key);
    if (cached) return cached;
    const started = generation;
    let raw: string | null;
    try { raw = await store.get(RECORD_PREFIX + key); } catch { throw new CustodyUnavailableError(); }
    const value = raw === null ? null : parseJson(raw);
    // Records written before `upgrade` existed carry only `folders`.
    const record: AccountRecord = value === null
      ? { folders: new Set(), upgrade: new Set() }
      : { folders: new Set(parseList(value, 'folders', true)), upgrade: new Set(parseList(value, 'upgrade', false)) };
    if (started === generation) cache.set(key, record);
    return record;
  }

  async function indexedAccounts(): Promise<string[]> {
    try {
      const raw = await store.get(INDEX_KEY);
      return raw === null ? [] : parseList(parseJson(raw), 'accounts', true);
    } catch { return []; }
  }

  // One durable change to an account's record, behind the queue and the epoch checks.
  function update(accountId: string | null, change: (next: AccountRecord) => void): Promise<void> {
    const key = accountKey(accountId);
    const started = generation;
    return serial(async () => {
      const known = await load(key);
      if (started !== generation) throw new StaleAccountError('custody memory');
      const next: AccountRecord = { folders: new Set(known.folders), upgrade: new Set(known.upgrade) };
      change(next);
      if (sameSet(known.folders, next.folders) && sameSet(known.upgrade, next.upgrade)) return;
      if (next.folders.size > MAX_FOLDERS_PER_ACCOUNT || next.upgrade.size > MAX_FOLDERS_PER_ACCOUNT) throw new CustodyUnavailableError();
      try {
        const accounts = new Set(await indexedAccounts()).add(key);
        if (started !== generation) throw new StaleAccountError('custody memory');
        // Index first: an index entry without a record is harmless, the reverse would hide it from the sweep.
        await store.set(INDEX_KEY, JSON.stringify({ v: 1, accounts: [...accounts].sort() }));
        await store.set(RECORD_PREFIX + key, JSON.stringify({ v: 1, folders: [...next.folders].sort(), upgrade: [...next.upgrade].sort() }));
      } catch (error) {
        throw error instanceof StaleAccountError ? error : new CustodyUnavailableError();
      }
      cache.set(key, next);
    });
  }

  return {
    async hasSeen(accountId, folderId) {
      const key = accountKey(accountId), id = folderKey(folderId);
      return (await load(key)).folders.has(id);
    },
    async isUpgradeRequired(accountId, folderId) {
      const key = accountKey(accountId), id = folderKey(folderId);
      return (await load(key)).upgrade.has(id);
    },
    async markSeen(accountId, folderId) {
      const id = folderKey(folderId);
      return update(accountId, next => { next.upgrade.delete(id); next.folders.add(id); });
    },
    async markUpgradeRequired(accountId, folderId) {
      const id = folderKey(folderId);
      // A folder already seen as custody stays custody: the server saying "upgrade" about it is not news we act on.
      return update(accountId, next => { if (!next.folders.has(id)) next.upgrade.add(id); });
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

/**
 * Mint-and-register path: never over a folder whose custody this account has seen (L7c), and never
 * over one the server said needs the owner's upgrade (L11).
 */
export async function assertMayRegisterCustody(memory: CustodyMemory, accountId: string | null, folderId: string): Promise<void> {
  if (await memory.hasSeen(accountId, folderId)) throw new CustodyUnavailableError();
  if (await memory.isUpgradeRequired(accountId, folderId)) throw new UpgradeRequiredError();
}

/**
 * A key write or custody registration failed. A 409 `upgrade_required` is recorded for the folder and
 * returned as the upgrade state; any other error returns null (the caller handles it as before).
 * Recording is best effort: this write is refused either way, so a Keychain failure must not hide it.
 */
export async function noteUpgradeRequired(memory: CustodyMemory, accountId: string | null, folderId: string, error: unknown): Promise<UpgradeRequiredError | null> {
  const state = toUpgradeRequired(error);
  if (!state) return null;
  await memory.markUpgradeRequired(accountId, folderId).catch(() => undefined);
  return state;
}

export const custodyMemory: CustodyMemory = createCustodyMemory(secureStoreCustodyPort);

/** Sign-out purge hook (`account-cleanup.ts`). */
export function clearCustodyMemory(): Promise<void> {
  return custodyMemory.clearAll();
}
