// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
// C1 native and C3 API Interfaces mocks; no native key bytes enter this harness.
import { beforeEach, expect, test } from 'bun:test';
import { createSharedKeyResolver, isKeyMismatchError, parseOwnerWrap } from './shared-folder-keys';
import { advanceAccountEpoch, accountEpoch } from './account-epoch';
import { ingestTree } from './shared-folder-tree';
import { setExpectedUserId } from './expected-user';
import { createCustodyMemory } from './shared-folder-custody';
const wrap = new Uint8Array(60).fill(1);
const b64 = btoa(String.fromCharCode(...wrap));
// Folder ids are canonical UUIDs (L7d); file ids are free-form here.
const A = 'aaaaaaaa-0000-4000-8000-00000000000a', B = 'bbbbbbbb-0000-4000-8000-00000000000b', Z = 'cccccccc-0000-4000-8000-00000000000c', R = 'dddddddd-0000-4000-8000-00000000000d';
const F = 'f', G = 'g';
const noMarker = { exists: async () => false, write: async () => {} };
function setup() {
  const probes: string[] = [], loads: unknown[] = []; let pages = 0, clears = 0, now = 0;
  const loaded = new Set<string>(), released: number[] = [];
  // The Keychain of the custody memory: a Map, so a "restart" is a new resolver over the same Map.
  const store = new Map<string, string>();
  const port = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); } };
  const p = {
    custody: createCustodyMemory(port, noMarker),
    getSharedFolder: async (id: string) => { probes.push(id); if (id !== A) throw { status: 404 }; return { folder_id: id, role: 'owner', owner_wrapped_folder_key: b64 }; },
    listSharedFolderKeys: async () => { pages++; return { keys: [{ file_id: F, encrypted_file_key: b64 }], next_cursor: null as string | null }; },
    getFileOwnerWrap: async (_id: string) => ({ ownerWrap: null as Uint8Array | null, actedViaShareId: null }),
    listFolderLinks: async () => [],
    masterHandleId: () => 1, epoch: accountEpoch, now: () => now,
    native: {
      isSharedKeysNativeReady: () => true,
      sharedFolderOpenOwnerKey: async () => 2,
      sharedFileKeysLoad: async (_m: number, _h: number, entries: { fileId: string }[]) => { loads.push(entries); entries.forEach(e => loaded.add(e.fileId)); return { loaded: entries.map(e => e.fileId), failed: [] as string[] }; },
      sharedFileKeyIsLoaded: (id: string) => loaded.has(id),
      sharedFileKeyOpenOwnerWrap: async (_m: number, id: string) => { loaded.add(id); return true; },
      sharedFolderDecryptName: async () => null,
      sharedFolderRelease: async (h: number) => { released.push(h); }, sharedKeysClear: async () => { clears++; loaded.clear(); },
    },
  };
  return { p, store, port, released, probes, loads, loaded, pages: () => pages, clears: () => clears, tick: (n: number) => { now += n; } };
}
// A "restart": a fresh setup() whose Keychain starts as a copy of another one's.
function restartedFrom(first: ReturnType<typeof setup>) { const s = setup(); for (const [k, v] of first.store) s.store.set(k, v); return s; }
beforeEach(() => { setExpectedUserId('acct-a'); ingestTree([{ id: A, parent_id: null }, { id: B, parent_id: A }, { id: F, parent_id: B, acted_via_share_id: 'link' }]); });
test('resolves_a_guest_file_through_its_nearest_shared_ancestor', async () => {
 const s = setup(), r = createSharedKeyResolver(s.p); expect((await r.ensureLoaded([F])).get(F)).toBe('loaded'); expect(s.probes).toEqual([B, A]); expect(s.pages()).toBe(1); expect(s.loads).toEqual([[{ fileId: F, wrapped: wrap }]]);
});
test('negative_custody_probe_is_cached_for_five_minutes', async () => {
 const s = setup(); ingestTree([{ id: F, parent_id: B }, { id: B, parent_id: null }]); const r = createSharedKeyResolver(s.p);
 await r.ensureLoaded([F]); await r.ensureLoaded([F]); expect(s.probes).toEqual([B]); s.tick(301000); await r.ensureLoaded([F]); expect(s.probes).toEqual([B, B]);
});
test('a_row_with_no_shared_ancestor_uses_the_owner_wrap_on_the_file_row', async () => {
 const s = setup(); ingestTree([]); s.p.getFileOwnerWrap = async () => ({ ownerWrap: wrap, actedViaShareId: null });
 expect(parseOwnerWrap(b64)).toEqual(wrap); expect(parseOwnerWrap([...wrap])).toEqual(wrap); expect(parseOwnerWrap([256])).toBeNull();
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('loaded');
});
test('a_plausible_but_bad_key_is_reported_not_thrown', async () => {
 const s = setup(); s.p.native.sharedFileKeysLoad = async () => ({ loaded: [], failed: [F] });
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('key_does_not_open');
});
test('keys_listing_is_paged_and_bounded_at_200_pages', async () => {
 const s = setup(); let n=0; s.p.listSharedFolderKeys = async () => { n++; return {keys:[],next_cursor:String(n)}; };
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('keys_incomplete'); expect(n).toBe(200); expect(s.loads).toEqual([]);
});
test('member_role_custody_is_ignored_in_phase_1', async () => {
 // Owner-side only: a member's folder never reads as legacy through the custody memory's refusal either.
 const s=setup(); s.p.getSharedFolder=async id=>({folder_id:id,role:'member',owner_wrapped_folder_key:b64}); expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('no_shared_root');
});
test('native_surface_missing_reports_update_required_with_zero_requests', async () => {
 const s=setup(); s.p.native.isSharedKeysNativeReady=()=>false; expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('update_required'); expect(s.probes).toEqual([]);
});
test('stale_account_epoch_discards_the_result_and_loads_nothing', async () => {
 const s=setup(); s.p.listSharedFolderKeys=async()=>{advanceAccountEpoch(); return {keys:[{file_id:F,encrypted_file_key:b64}],next_cursor:null};};
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('stale'); expect(s.loads).toEqual([]);
});
test('lock_clears_roots_maps_and_the_native_table', async () => {
 const s=setup(), r=createSharedKeyResolver(s.p); await r.ensureLoaded([F]); r.clear(); expect(s.clears()).toBe(1); await r.ensureLoaded([F]); expect(s.probes).toEqual([B,A,B,A]);
});
test('isKeyMismatchError_matches_core_auth_failures_on_both_platforms', () => {
 // Source-derived core/bridge strings; live simulator/emulator capture deferred to lead.
 for(const m of ['Decryption failed','authentication failed','CryptoException: AeadError','InvalidTag']) expect(isKeyMismatchError(new Error(m))).toBe(true);
 expect(isKeyMismatchError(new Error('HTTP 500'))).toBe(false);
});

// L7d (decision, plan C): the custody memory belongs to the DEVICE. The resolver records custody it
// opened and never reads a later 404/405/501 for that folder as "legacy", whoever is signed in.
test('a_seen_folder_that_later_answers_404_405_or_501_is_refused_not_legacy', async () => {
 for (const status of [404, 405, 501]) {
  const first = setup(); expect((await createSharedKeyResolver(first.p).ensureLoaded([F])).get(F)).toBe('loaded');
  const s = restartedFrom(first); // an app restart: same Keychain, new process
  let owner = 0; s.p.getFileOwnerWrap = async () => { owner++; return { ownerWrap: wrap, actedViaShareId: null }; };
  s.p.getSharedFolder = async () => { throw { status }; };
  let opened = 0; s.p.native.sharedFolderOpenOwnerKey = async () => { opened++; return 2; };
  const out = await createSharedKeyResolver(s.p).ensureLoaded([F]);
  expect(out.get(F)).toBe('custody_unavailable'); expect(opened).toBe(0); expect(s.loads).toEqual([]); expect(owner).toBe(0); expect(s.pages()).toBe(0);
 }
});
test('a_forced_sign_out_and_another_sign_in_do_not_empty_the_memory', async () => {
 const first = setup(); await createSharedKeyResolver(first.p).ensureLoaded([F]);
 advanceAccountEpoch(); setExpectedUserId(null); advanceAccountEpoch(); setExpectedUserId('acct-b'); // 401 sign-out, then someone else signs in
 ingestTree([{ id: A, parent_id: null }, { id: B, parent_id: A }, { id: F, parent_id: B }]); // the epoch advance dropped the tree; the new session loads it again
 const s = restartedFrom(first); s.p.getSharedFolder = async () => { throw { status: 404 }; };
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('custody_unavailable');
});
test('any_ancestor_that_was_seen_refuses_even_when_a_nearer_one_reads_as_legacy_and_a_cached_verdict_cannot_hide_it', async () => {
 // F sits under B (never seen, 404 = legacy) under R (seen). The walk must not stop at B.
 ingestTree([{ id: R, parent_id: null }, { id: B, parent_id: R }, { id: F, parent_id: B }]);
 const first = setup(); first.p.getSharedFolder = async id => { if (id === R) return { folder_id: id, role: 'owner', owner_wrapped_folder_key: b64 }; throw { status: 404 }; };
 await first.p.custody.markSeen(R); // R's custody was opened earlier
 const s = restartedFrom(first); s.p.getSharedFolder = async id => { s.probes.push(id); throw { status: 404 }; };
 let owner = 0; s.p.getFileOwnerWrap = async () => { owner++; return { ownerWrap: wrap, actedViaShareId: null }; };
 const out = await createSharedKeyResolver(s.p).ensureLoaded([F]);
 expect(out.get(F)).toBe('custody_unavailable'); expect(s.probes).toEqual([B, R]); expect(owner).toBe(0); expect(s.loads).toEqual([]);
 // A legacy verdict cached for R from before R was seen must not survive R becoming seen.
 const t = setup(); t.p.getSharedFolder = async () => { throw { status: 404 }; };
 const r = createSharedKeyResolver(t.p); expect((await r.ensureLoaded([F])).get(F)).toBe('no_shared_root');
 await t.p.custody.markSeen(R); // e.g. another screen opened R meanwhile
 expect((await r.ensureLoaded([F])).get(F)).toBe('custody_unavailable');
});
test('a_never_seen_folder_that_answers_404_405_or_501_reads_as_legacy_and_the_owner_fallback_still_runs', async () => {
 for (const status of [404, 405, 501]) {
  const s = setup(); s.p.getSharedFolder = async () => { throw { status }; }; s.p.getFileOwnerWrap = async () => ({ ownerWrap: wrap, actedViaShareId: null });
  expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('loaded'); expect(s.pages()).toBe(0);
 }
});
test('a_200_whose_record_no_longer_opens_is_refused_once_the_folder_was_seen', async () => {
 // Owner-side only: this refusal is for the owner's custody folder, never for a member's read.
 const first = setup(); await createSharedKeyResolver(first.p).ensureLoaded([F]);
 for (const info of [{ role: 'member', owner_wrapped_folder_key: b64 }, { role: 'owner', owner_wrapped_folder_key: null }, { role: 'owner', owner_wrapped_folder_key: 'AAAA' }]) {
  const s = restartedFrom(first);
  s.p.getSharedFolder = async (id: string) => ({ folder_id: id, ...info });
  expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('custody_unavailable'); expect(s.loads).toEqual([]);
 }
});
test('custody_is_recorded_durably_before_any_wrap_is_read', async () => {
 const s = setup(); let seenAtListing: boolean | null = null;
 s.p.listSharedFolderKeys = async () => { seenAtListing = await s.p.custody.hasSeen(A); return { keys: [{ file_id: F, encrypted_file_key: b64 }], next_cursor: null }; };
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('loaded'); expect(seenAtListing).toBe(true);
});
test('a_custody_record_that_cannot_be_stored_is_not_used_and_its_handle_is_released', async () => {
 const s = setup(); s.port.set = async () => { throw new Error('keychain'); };
 expect((await createSharedKeyResolver(s.p).ensureLoaded([F])).get(F)).toBe('custody_unavailable');
 expect(s.released).toEqual([2]); expect(s.pages()).toBe(0); expect(s.loads).toEqual([]);
});
test('a_refused_folder_does_not_block_another_shared_folder_in_the_same_call', async () => {
 const first = setup(); await createSharedKeyResolver(first.p).ensureLoaded([F]);
 ingestTree([{ id: A, parent_id: null }, { id: B, parent_id: A }, { id: F, parent_id: B }, { id: Z, parent_id: null }, { id: G, parent_id: Z }]);
 const s = restartedFrom(first);
 s.p.getSharedFolder = async (id: string) => { if (id === Z) return { folder_id: id, role: 'owner', owner_wrapped_folder_key: b64 }; throw { status: 404 }; };
 s.p.listSharedFolderKeys = async () => ({ keys: [{ file_id: G, encrypted_file_key: b64 }], next_cursor: null });
 const out = await createSharedKeyResolver(s.p).ensureLoaded([F, G]);
 expect(out.get(F)).toBe('custody_unavailable'); expect(out.get(G)).toBe('loaded');
});
test('a_seen_folder_whose_record_stops_opening_is_refused_and_a_never_seen_one_reports_the_open_failure', async () => {
 const first = setup(); await createSharedKeyResolver(first.p).ensureLoaded([F]);
 const seen = restartedFrom(first);
 seen.p.native.sharedFolderOpenOwnerKey = async () => { throw new Error('Decryption failed'); };
 expect((await createSharedKeyResolver(seen.p).ensureLoaded([F])).get(F)).toBe('custody_unavailable');
 const fresh = setup(); fresh.p.native.sharedFolderOpenOwnerKey = async () => { throw new Error('Decryption failed'); };
 expect((await createSharedKeyResolver(fresh.p).ensureLoaded([F])).get(F)).toBe('key_does_not_open');
});
test('a_folders_own_new_custody_is_not_refused_by_the_cached_no_custody_verdict', async () => {
 // F under B under A. The first read finds no custody (cached for 5 minutes). Link creation then registers
 // custody for A (markSeen) and the server now has the record: the next read must ask afresh and open it.
 const s = setup(); s.p.getSharedFolder = async (id: string) => { s.probes.push(id); throw { status: 404 }; };
 const r = createSharedKeyResolver(s.p);
 expect((await r.ensureLoaded([F])).get(F)).toBe('no_shared_root'); expect(s.probes).toEqual([B, A]);
 await s.p.custody.markSeen(A); // what link creation does after its custody PUT
 s.p.getSharedFolder = async (id: string) => { s.probes.push(id); if (id !== A) throw { status: 404 }; return { folder_id: id, role: 'owner', owner_wrapped_folder_key: b64 }; };
 const out = await r.ensureLoaded([F]);
 expect(out.get(F)).toBe('loaded'); expect(s.probes).toEqual([B, A, A]); // B's verdict stands (never seen); A is asked afresh
 expect(s.pages()).toBe(1);
});
test('a_cached_no_custody_verdict_still_stands_for_a_folder_never_seen', async () => {
 const s = setup(); s.p.getSharedFolder = async (id: string) => { s.probes.push(id); throw { status: 404 }; };
 const r = createSharedKeyResolver(s.p); await r.ensureLoaded([F]); await r.ensureLoaded([F]);
 expect(s.probes).toEqual([B, A]); // no second GET inside the 5 minutes
});
