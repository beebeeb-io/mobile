// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
// C1 native and C3 API Interfaces mocks; no native key bytes enter this harness.
import { beforeEach, expect, test } from 'bun:test';
import { createSharedKeyResolver, isKeyMismatchError, parseOwnerWrap } from './shared-folder-keys';
import { advanceAccountEpoch, accountEpoch } from './account-epoch';
import { ingestTree } from './shared-folder-tree';
const wrap = new Uint8Array(60).fill(1);
const b64 = btoa(String.fromCharCode(...wrap));
function setup() {
  const probes: string[] = [], loads: unknown[] = []; let pages = 0, clears = 0, now = 0;
  const loaded = new Set<string>();
  const p = {
    getSharedFolder: async (id: string) => { probes.push(id); if (id !== 'a') throw { status: 404 }; return { folder_id: id, role: 'owner', owner_wrapped_folder_key: b64 }; },
    listSharedFolderKeys: async () => { pages++; return { keys: [{ file_id: 'f', encrypted_file_key: b64 }], next_cursor: null as string | null }; },
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
      sharedFolderRelease: async () => {}, sharedKeysClear: async () => { clears++; loaded.clear(); },
    },
  };
  return { p, probes, loads, loaded, pages: () => pages, clears: () => clears, tick: (n: number) => { now += n; } };
}
beforeEach(() => { ingestTree([{ id: 'a', parent_id: null }, { id: 'b', parent_id: 'a' }, { id: 'f', parent_id: 'b', acted_via_share_id: 'link' }]); });
test('resolves_a_guest_file_through_its_nearest_shared_ancestor', async () => {
 const s = setup(), r = createSharedKeyResolver(s.p); expect((await r.ensureLoaded(['f'])).get('f')).toBe('loaded'); expect(s.probes).toEqual(['b','a']); expect(s.pages()).toBe(1); expect(s.loads).toEqual([[{ fileId: 'f', wrapped: wrap }]]);
});
test('negative_custody_probe_is_cached_for_five_minutes', async () => {
 const s = setup(); ingestTree([{ id:'f',parent_id:'b' }, { id:'b',parent_id:null }]); const r = createSharedKeyResolver(s.p);
 await r.ensureLoaded(['f']); await r.ensureLoaded(['f']); expect(s.probes).toEqual(['b']); s.tick(301000); await r.ensureLoaded(['f']); expect(s.probes).toEqual(['b','b']);
});
test('a_row_with_no_shared_ancestor_uses_the_owner_wrap_on_the_file_row', async () => {
 const s = setup(); ingestTree([]); s.p.getFileOwnerWrap = async () => ({ ownerWrap: wrap, actedViaShareId: null });
 expect(parseOwnerWrap(b64)).toEqual(wrap); expect(parseOwnerWrap([...wrap])).toEqual(wrap); expect(parseOwnerWrap([256])).toBeNull();
 expect((await createSharedKeyResolver(s.p).ensureLoaded(['f'])).get('f')).toBe('loaded');
});
test('a_plausible_but_bad_key_is_reported_not_thrown', async () => {
 const s = setup(); s.p.native.sharedFileKeysLoad = async () => ({ loaded: [], failed: ['f'] });
 expect((await createSharedKeyResolver(s.p).ensureLoaded(['f'])).get('f')).toBe('key_does_not_open');
});
test('keys_listing_is_paged_and_bounded_at_200_pages', async () => {
 const s = setup(); let n=0; s.p.listSharedFolderKeys = async () => { n++; return {keys:[],next_cursor:String(n)}; };
 expect((await createSharedKeyResolver(s.p).ensureLoaded(['f'])).get('f')).toBe('keys_incomplete'); expect(n).toBe(200); expect(s.loads).toEqual([]);
});
test('member_role_custody_is_ignored_in_phase_1', async () => {
 const s=setup(); s.p.getSharedFolder=async id=>({folder_id:id,role:'member',owner_wrapped_folder_key:b64}); expect((await createSharedKeyResolver(s.p).ensureLoaded(['f'])).get('f')).toBe('no_shared_root');
});
test('native_surface_missing_reports_update_required_with_zero_requests', async () => {
 const s=setup(); s.p.native.isSharedKeysNativeReady=()=>false; expect((await createSharedKeyResolver(s.p).ensureLoaded(['f'])).get('f')).toBe('update_required'); expect(s.probes).toEqual([]);
});
test('stale_account_epoch_discards_the_result_and_loads_nothing', async () => {
 const s=setup(); s.p.listSharedFolderKeys=async()=>{advanceAccountEpoch(); return {keys:[{file_id:'f',encrypted_file_key:b64}],next_cursor:null};};
 expect((await createSharedKeyResolver(s.p).ensureLoaded(['f'])).get('f')).toBe('stale'); expect(s.loads).toEqual([]);
});
test('lock_clears_roots_maps_and_the_native_table', async () => {
 const s=setup(), r=createSharedKeyResolver(s.p); await r.ensureLoaded(['f']); r.clear(); expect(s.clears()).toBe(1); await r.ensureLoaded(['f']); expect(s.probes).toEqual(['b','a','b','a']);
});
test('isKeyMismatchError_matches_core_auth_failures_on_both_platforms', () => {
 // Source-derived core/bridge strings; live simulator/emulator capture deferred to lead.
 for(const m of ['Decryption failed','authentication failed','CryptoException: AeadError','InvalidTag']) expect(isKeyMismatchError(new Error(m))).toBe(true);
 expect(isKeyMismatchError(new Error('HTTP 500'))).toBe(false);
});
