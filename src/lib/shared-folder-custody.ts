/**
 * Task 2237c, decisions L7d (supersedes L7c's "per account"), L10 and L11 (plan C;
 * contract-2237-format-l7.md §1 and §2): shared-folder custody is one-way, per DEVICE.
 *
 * The server is untrusted. The format a client uses for a shared folder's child wraps follows
 * custody (L7b): a folder WITH a custody record is L7 for every read and write, a folder WITHOUT
 * one (a flag-off invite) stays on the legacy reader. If that decision were remade from the custody
 * GET on every call, a server could answer 404 (or 405/501) for a folder the client already opened
 * and flip it back to the legacy, unbound reader.
 *
 * So the first time this device has seen a folder's custody record AND opened it under the L6 key,
 * the fact is recorded durably, before the folder key is used. From then on:
 *   - a 404/405/501 for that folder, or a 200 whose record no longer opens, is an ERROR
 *     (`CustodyUnavailableError`, "This folder's keys are unavailable"), never "legacy";
 *   - no fresh random folder key is minted over it (`assertMayRegisterCustody`): L1 says a client
 *     mints only when the server has no record, and a downgrading server would say so.
 * L11: a folder the server answered 409 `upgrade_required` on (it already has key rows and no
 * custody) is never minted over either; only the owner's upgrade gives it custody. That is recorded
 * the same way (`noteUpgradeRequired`) and ends when custody is later seen and opened.
 * A folder this device never saw custody for keeps the L7b behaviour: 404/405/501 = legacy.
 *
 * Why the DEVICE and not the account (L7d): one 401 runs the signed-out purge, and a server can force
 * a 401. A memory the purge clears is a memory the server can empty, then downgrade. So there is one
 * device-wide set of folder ids, keyed by no account id or digest, and nothing in this app removes an
 * entry: not sign-out, not an account switch, not the purge. Only the user removing the app's data does.
 * Folder ids are canonical UUIDs (any other form is refused, never remembered, never read as unseen).
 *
 * Unreadable is not unseen. A SecureStore that cannot be read or written refuses. On Android a lost
 * Keystore key makes expo-secure-store return null, which would read as "never seen"; so the first
 * stored entry also arms a marker OUTSIDE SecureStore: a native one-byte file in no-backup storage
 * (Android `noBackupFilesDir`; iOS Application Support, excluded from backup), which the OS does not
 * purge under storage pressure, the user's "Clear cache" does not delete, and the sign-out sweep never
 * touches. It holds no ids. Marker present plus a null set is `CustodyUnavailableError`, and only the
 * user removing the app's data recovers it. A marker that cannot be written the first time fails
 * `markSeen` (the folder key is not used); once armed, later marker writes are best effort. A readable
 * set re-arms a marker that went missing.
 *
 * Call order, in the resolver (#233) and link creation (#234):
 *   1. `GET /shared-folders/{id}` returns a record: open it under the L6 key (`sharedFolderOpenOwnerKey`);
 *   2. `await memory.markSeen(folderId)`; if that fails, `sharedFolderRelease(handle)` and refuse;
 *   3. only then `sharedFileKeysLoad` and any use of the folder key.
 *   The client's own custody registration (mint, PUT accepted) is followed by `markSeen` before its first
 *   L7 write.
 *   On 404/405/501 (`isCustodyAbsentStatus`), or a 200 record that is not the owner's or does not parse:
 *   `await settleMissingCustody(memory, folderId)` gives 'legacy' for a folder never seen, or throws. A
 *   non-owner record reaches it too (mobile ignores member custody in phase 1): never seen = legacy,
 *   seen = refused.
 *   Before minting + registering custody: `assertMayRegisterCustody`. Every key write for a custody
 *   folder: `withL7Format(body)` (L10). A 409 on a key write or on registering custody:
 *   `noteUpgradeRequired(...)` is the honest "the owner must convert this folder first" state (L11),
 *   never a retry as legacy.
 */

const RECORD_KEY = 'beebeeb.custody-seen.v1';
// 5,000 folders is ~190 KB; past that the memory would rather refuse than forget.
const MAX_FOLDERS = 5000;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** 404/405/501 on the custody GET: no custody record (L7b/L7d), or a server pretending so. */
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
};

/** The "a set was stored here" flag, kept outside SecureStore. `exists` throws when it cannot tell. */
export interface CustodyMarkerPort {
  exists(): Promise<boolean>;
  write(): Promise<void>;
}

// The marker is two native calls into no-backup storage (see the header). A build without them throws,
// which `load` reads as "cannot tell" and `update` as "cannot arm": fail closed.
async function nativeMarker() {
  const native = await import('../../modules/beebeeb-crypto');
  if (typeof native.custodyMarkerExists !== 'function' || typeof native.writeCustodyMarker !== 'function') {
    throw new Error('The custody marker is not available in this build');
  }
  return native;
}

export const nativeMarkerPort: CustodyMarkerPort = {
  exists: async () => (await nativeMarker()).custodyMarkerExists(),
  write: async () => (await nativeMarker()).writeCustodyMarker(),
};

export interface CustodyMemory {
  /** True once this device has seen and opened the folder's custody. Refuses when unprovable. */
  hasSeen(folderId: string): Promise<boolean>;
  /** Durable, idempotent. Resolves only after the record is stored. Ends an `upgrade_required` mark. */
  markSeen(folderId: string): Promise<void>;
  /** True while the server's last word on this folder was 409 `upgrade_required` (L11). */
  isUpgradeRequired(folderId: string): Promise<boolean>;
  /** Durable, idempotent: this folder needs the owner's upgrade, never a fresh custody. */
  markUpgradeRequired(folderId: string): Promise<void>;
}

interface DeviceRecord { folders: Set<string>; upgrade: Set<string> }

// Case-insensitive on purpose (the server may send either case); the lowercase form is what is stored.
function canonicalFolderId(folderId: unknown): string {
  const id = typeof folderId === 'string' ? folderId.toLowerCase() : '';
  if (!CANONICAL_UUID.test(id)) throw new CustodyUnavailableError();
  return id;
}

function parseIds(value: unknown, field: string, required: boolean): string[] {
  const list = (value as Record<string, unknown> | null)?.[field];
  if (list === undefined && !required) return [];
  if (!Array.isArray(list) || !list.every(item => typeof item === 'string')) throw new CustodyUnavailableError();
  return list as string[];
}

function parseRecord(raw: string): DeviceRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CustodyUnavailableError(); }
  if ((value as { v?: unknown } | null)?.v !== 1) throw new CustodyUnavailableError();
  // Records written before `upgrade` existed carry only `folders`.
  return { folders: new Set(parseIds(value, 'folders', true)), upgrade: new Set(parseIds(value, 'upgrade', false)) };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(item => b.has(item));
}

export function createCustodyMemory(store: CustodyStorePort, marker: CustodyMarkerPort = nativeMarkerPort): CustodyMemory {
  let cache: DeviceRecord | null = null;
  // Whether the marker is known to exist: true after a read or a successful write, null while unknown.
  let armed: boolean | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  // Every read and write takes its turn, so a read never answers from before a write still in flight.
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  async function load(): Promise<DeviceRecord> {
    if (cache) return cache;
    let raw: string | null;
    try { raw = await store.get(RECORD_KEY); } catch { throw new CustodyUnavailableError(); }
    if (raw === null) {
      // A null read is only believable if no set was ever stored here (a lost Keystore key reads null).
      let present: boolean;
      try { present = await marker.exists(); } catch { throw new CustodyUnavailableError(); }
      if (present) throw new CustodyUnavailableError();
      armed = false;
      cache = { folders: new Set(), upgrade: new Set() };
      return cache;
    }
    const record = parseRecord(raw);
    // A readable set re-arms a marker that went missing; best effort, the set itself is the truth.
    if (record.folders.size + record.upgrade.size > 0) {
      armed = await marker.exists().then(async present => { if (!present) await marker.write(); return true; }).catch(() => null);
    }
    cache = record;
    return record;
  }

  function update(change: (next: DeviceRecord) => void): Promise<void> {
    return serial(async () => {
      const known = await load();
      const next: DeviceRecord = { folders: new Set(known.folders), upgrade: new Set(known.upgrade) };
      change(next);
      if (!(sameSet(known.folders, next.folders) && sameSet(known.upgrade, next.upgrade))) {
        if (next.folders.size > MAX_FOLDERS || next.upgrade.size > MAX_FOLDERS) throw new CustodyUnavailableError();
        try { await store.set(RECORD_KEY, JSON.stringify({ v: 1, folders: [...next.folders].sort(), upgrade: [...next.upgrade].sort() })); }
        catch { throw new CustodyUnavailableError(); }
        cache = next;
      }
      // The marker is owed whenever it is not known to exist, even when the set already held the folder: if the
      // FIRST write fails the caller must not use the folder key. Once armed, a failed refresh is best effort.
      if (armed !== true) {
        try { await marker.write(); armed = true; } catch { throw new CustodyUnavailableError(); }
      } else {
        await marker.write().catch(() => undefined);
      }
    });
  }

  return {
    async hasSeen(folderId) {
      const id = canonicalFolderId(folderId);
      return serial(async () => (await load()).folders.has(id));
    },
    async isUpgradeRequired(folderId) {
      const id = canonicalFolderId(folderId);
      return serial(async () => (await load()).upgrade.has(id));
    },
    async markSeen(folderId) {
      const id = canonicalFolderId(folderId);
      return update(next => { next.upgrade.delete(id); next.folders.add(id); });
    },
    async markUpgradeRequired(folderId) {
      const id = canonicalFolderId(folderId);
      // A folder already seen as custody stays custody: the server saying "upgrade" about it is not news we act on.
      return update(next => { if (!next.folders.has(id)) next.upgrade.add(id); });
    },
  };
}

/**
 * The folder's custody is missing or unusable. Never seen: 'legacy' (L7b). Seen before: refuse (L7d).
 * Throws `CustodyUnavailableError` when the memory cannot answer, so doubt never reads as legacy.
 */
export async function settleMissingCustody(memory: CustodyMemory, folderId: string): Promise<'legacy'> {
  if (await memory.hasSeen(folderId)) throw new CustodyUnavailableError();
  return 'legacy';
}

/**
 * Mint-and-register path: never over a folder whose custody this device has seen (L7d), and never
 * over one the server said needs the owner's upgrade (L11).
 */
export async function assertMayRegisterCustody(memory: CustodyMemory, folderId: string): Promise<void> {
  if (await memory.hasSeen(folderId)) throw new CustodyUnavailableError();
  if (await memory.isUpgradeRequired(folderId)) throw new UpgradeRequiredError();
}

/**
 * A key write or custody registration failed. A 409 `upgrade_required` is recorded for the folder and
 * returned as the upgrade state; any other error returns null (the caller handles it as before).
 * Recording is best effort: this write is refused either way, so a Keychain failure must not hide it.
 */
export async function noteUpgradeRequired(memory: CustodyMemory, folderId: string, error: unknown): Promise<UpgradeRequiredError | null> {
  const state = toUpgradeRequired(error);
  if (!state) return null;
  await memory.markUpgradeRequired(folderId).catch(() => undefined);
  return state;
}

export const custodyMemory: CustodyMemory = createCustodyMemory(secureStoreCustodyPort);
