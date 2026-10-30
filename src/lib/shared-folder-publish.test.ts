// @ts-nocheck -- C1/C3 promised Interfaces are explicitly mocked through ports.
import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createSharedFolderPublisher, isPublishableOwnedFile, retryPending, clearPendingPublishes } from './shared-folder-publish';
import { clearTree, ingestTree, ancestorsOf } from './shared-folder-tree';
import { createCustodyMemory } from './shared-folder-custody';
const DAY = 86_400_000;
function setup(root='R') {
  clearTree(); ingestTree([{id:'sub',parent_id:root}]);
  let clock=1000, disk=null, status=0, enabled=true, lists=0, wraps=0;
  const posts=[], store=new Map();
  const p={
    enabled:async()=>enabled,
    links:async()=>{lists++;return [{folder_id:root,revoked_at:null,expires_at:null}];},
    custody:createCustodyMemory({get:async k=>store.get(k)??null,set:async(k,v)=>{store.set(k,v);}},{exists:async()=>false,write:async()=>{}}),
    folderHandleFor:async()=>7,
    // Marked C1 mock: returns only ciphertext wraps, never a file key.
    wrap:async(handle,ids)=>{expect(handle).toBe(7);wraps++;return ids.map(fileId=>({fileId,wrapped:new Uint8Array(60).fill(3)}));},
    publish:async(root,keys)=>{posts.push({root,keys});if(status)throw Object.assign(Error('endpoint failure'),{status});return {written:keys.length,skipped:0};},
    ancestors:ancestorsOf, eligible:id=>isPublishableOwnedFile(id,'owner'),
    read:async()=>disk,write:async value=>{disk=value;},remove:async()=>{disk=null;},
    now:()=>clock,current:()=>true,
  };
  return {p,posts,store,disk:()=>disk,lists:()=>lists,wraps:()=>wraps,setStatus:v=>status=v,setEnabled:v=>enabled=v,advance:n=>clock+=n};
}
test('an_owner_upload_into_a_shared_subtree_publishes_one_wrap',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p); a.onOwnerUpload({id:'f',parent_id:'sub'});await a.idle();
  expect(s.posts).toHaveLength(1);expect(s.posts[0].root).toBe('R');
  expect(s.posts[0].keys).toHaveLength(1);expect(s.posts[0].keys[0].file_id).toBe('f');expect(atob(s.posts[0].keys[0].encrypted_file_key).length).toBe(60);
  expect(s.wraps()).toBe(1);expect(s.lists()).toBe(1);
});
test('an_upload_outside_any_shared_root_makes_no_request',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);a.onOwnerUpload({id:'f',parent_id:'private'});await a.idle();
  expect(s.posts).toEqual([]);expect(s.wraps()).toBe(0); // Discovery is allowed; no key-list GET or publish POST.
});
test('a_failed_publish_is_retried_until_the_seven_day_window_ends',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);s.setStatus(500);a.onOwnerUpload({id:'f',parent_id:'R'});await a.idle();
  expect(s.posts).toHaveLength(1);expect(JSON.parse(s.disk())).toEqual([{fileId:'f',parentId:'R',rootId:'R',createdAt:1000}]);
  s.setStatus(0);await a.retryPending();expect(s.posts).toHaveLength(2);expect(JSON.parse(s.disk())).toEqual([]);
  s.setStatus(500);a.onOwnerUpload({id:'expired',parent_id:'R'});await a.idle();const n=s.posts.length;s.advance(8*DAY);await a.retryPending();expect(s.posts).toHaveLength(n);expect(JSON.parse(s.disk())).toEqual([]);
});
test('the_publish_hook_never_throws_into_the_upload',async()=>{
  const s=setup();s.p.links=async()=>{throw Error('offline');};const a=createSharedFolderPublisher(s.p);
  expect(()=>a.onOwnerUpload({id:'f',parent_id:'R'})).not.toThrow();await expect(a.idle()).resolves.toBeUndefined();
  s.p.links=async()=>[{folder_id:'R'}];await a.retryPending();expect(s.posts).toHaveLength(1);
});
test('roots_cache_expires_after_five_minutes_and_clears_on_lock',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);
  for(let i=0;i<2;i++){a.onOwnerUpload({id:`f${i}`,parent_id:'R'});await a.idle();}expect(s.lists()).toBe(1);
  s.advance(5*60_000+1);a.onOwnerUpload({id:'f2',parent_id:'R'});await a.idle();expect(s.lists()).toBe(2);
  a.invalidate();const b=createSharedFolderPublisher(s.p);b.onOwnerUpload({id:'f3',parent_id:'R'});await b.idle();expect(s.lists()).toBe(3);
});
test('flag_off_makes_no_request',async()=>{
  const s=setup();s.setEnabled(false);s.p.read=async()=>{throw Error('should not read');};const a=createSharedFolderPublisher(s.p);
  a.onOwnerUpload({id:'f',parent_id:'R'});await a.idle();await a.publishOwnedKeys('R',['f']);await a.retryPending();
  expect(s.posts).toEqual([]);expect(s.lists()).toBe(0);expect(s.wraps()).toBe(0);expect(s.disk()).toBeNull();
});
test('the_retry_queue_survives_relaunch_and_contains_only_ids_and_age',async()=>{
  const s=setup();s.setStatus(500);const a=createSharedFolderPublisher(s.p);await a.publishOwnedKeys('R',['f']);
  const row=JSON.parse(s.disk())[0];expect(Object.keys(row).sort()).toEqual(['createdAt','fileId','parentId','rootId']);
  a.invalidate();s.setStatus(0);await createSharedFolderPublisher(s.p).retryPending();expect(s.posts).toHaveLength(2);expect(JSON.parse(s.disk())).toEqual([]);
});
test('request_uploads_and_foreign_file_keys_are_never_wrapped_as_owner_keys',async()=>{
  const s=setup();ingestTree([{id:'request',file_request_id:'req'},{id:'guest',acted_via_share_id:'link'},{id:'member',uploaded_by:'other'}]);
  await createSharedFolderPublisher(s.p).publishOwnedKeys('R',['request','guest','member','own']);expect(s.posts[0].keys.map(k=>k.file_id)).toEqual(['own']);
});
test('a_late_native_result_cannot_publish_or_recreate_a_purged_queue',async()=>{
  const s=setup();let release;s.p.wrap=async(h,ids)=>{await new Promise(r=>release=r);return ids.map(fileId=>({fileId,wrapped:new Uint8Array(60)}));};
  const a=createSharedFolderPublisher(s.p);const work=a.publishOwnedKeys('R',['f']);for(let i=0;i<30&&!release;i++)await Promise.resolve();expect(typeof release).toBe('function');
  const purge=a.clearPending();release();await work;await purge;expect(s.posts).toEqual([]);expect(s.disk()).toBeNull();
});
test('batches_are_bounded_and_bad_native_wraps_are_not_posted',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);await a.publishOwnedKeys('R',Array.from({length:1001},(_,i)=>`f${i}`));
  expect(s.posts.map(p=>p.keys.length)).toEqual([1000,1]);s.p.wrap=async()=>[{fileId:'wrong',wrapped:new Uint8Array(59)}];await a.publishOwnedKeys('R',['bad']);expect(s.posts).toHaveLength(2);
});
test('revoked_and_expired_links_are_not_publish_roots',async()=>{
  const s=setup();s.p.links=async()=>[{folder_id:'R',revoked_at:'today'},{folder_id:'R',expires_at:new Date(0).toISOString()}];
  const a=createSharedFolderPublisher(s.p);a.onOwnerUpload({id:'f',parent_id:'R'});await a.idle();expect(s.posts).toEqual([]);
});
test('production_hooks_cover_both_upload_engines_unlock_foreground_and_sign_out',()=>{
  const source=file=>readFileSync(new URL(file,import.meta.url),'utf8');
  const upload=source('./encrypted-upload.ts');expect((upload.match(/onOwnerUpload\(/g)??[]).length).toBe(2);
  const crypto=source('./crypto-context.tsx');expect(crypto.includes("addEventListener('change'")).toBe(true);expect(crypto.includes("state === 'active'")).toBe(true);expect((crypto.match(/retryPending\(/g)??[]).length).toBeGreaterThanOrEqual(2);
  expect(source('./account-cleanup.ts').includes('clearPendingPublishes()')).toBe(true);
});

// End-to-end JS hook wiring with marked native/C3 endpoint mocks.
const runtimeDisk = new Map<string, string>(), runtimePosts: unknown[] = [];
let nativeEngine = true, engineWait: (() => Promise<unknown>) | null = null;
let completedEntry = { id: 'native-result', parent_id: undefined };
mock.module('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async uri => ({ exists: uri === 'file:///source' || runtimeDisk.has(uri), size: 3 }),
  readAsStringAsync: async uri => runtimeDisk.get(uri),
  writeAsStringAsync: async (uri, value) => { runtimeDisk.set(uri, value); },
  deleteAsync: async uri => { runtimeDisk.delete(uri); },
  readDirectoryAsync: async () => [...runtimeDisk.keys()].map(uri => uri.split('/').pop()),
}));
mock.module('./files-mount-default', () => ({ accountDigest: () => '0123456789abcdef' }));
const runtimeNative = {
  isSharedKeysNativeReady: () => true, sharedFileKeyIsLoaded: () => false,
  generateRandomBytes: async n => new Uint8Array(n),
  sharedWrapChildKeys: async (master, folder, ids) => {
    expect(master).toBe(9); expect(folder).toBe(7);
    return ids.map(fileId => ({ fileId, wrapped: new Uint8Array(60) }));
  },
};
mock.module('../../modules/beebeeb-crypto', () => runtimeNative);
mock.module('./api', () => ({
  getEvaluateFlags: async () => ({ flags: { shared_folders_v1: true } }),
  listFolderLinks: async () => [{ folder_id: 'R' }],
  publishSharedFolderKeys: async (root, keys) => { runtimePosts.push({root,keys}); return {written:keys.length,skipped:0}; },
  uploadEncryptedFileNative: async () => engineWait ? engineWait() : nativeEngine ? completedEntry : null,
  uploadEncryptedChunked: async () => completedEntry,
  registerUploadAbort: () => new AbortController().signal,
  settleUploadSignal: () => {}, clearUploadResumeState: async () => {},
}));
async function runtimeSession(id = 'owner') {
  const {setExpectedUserId} = await import('./expected-user');
  const {advanceAccountEpoch} = await import('./account-epoch');
  const {configureSharedKeys,setSharedKeyResolver} = await import('./shared-folder-keys');
  advanceAccountEpoch(); setExpectedUserId(id);
  configureSharedKeys(runtimeNative, {}, () => 9);
  setSharedKeyResolver({folderHandleFor:async()=>7,clear:()=>{}});
}
const uploadOptions = {fileId:'client-id',uri:'file:///source',name:'private.txt',parentId:'R',masterKeyHandleId:9,
  encryptChunkFn:async()=>({nonce:new Uint8Array(12),ciphertext:new Uint8Array(16)}),
  encryptMetadataFn:async()=>({nonce:new Uint8Array(12),ciphertext:new Uint8Array(16)})};
// Task SF-0001 (2275 L13): both engines publish the id this client chose (the
// id the upload was completed under), never an id an answer reported.
test('both_actual_upload_engines_publish_the_id_the_client_chose',async()=>{
  await runtimeSession(); runtimePosts.length=0;
  const {encryptedUpload} = await import('./encrypted-upload');
  for (const native of [true,false]) {
    nativeEngine=native; completedEntry={id:native?'native-result':'js-result',parent_id:undefined};
    expect(await encryptedUpload(uploadOptions)).toBe(completedEntry);
    await retryPending();
  }
  expect(runtimePosts.map(p=>[p.root,p.keys.map(k=>k.file_id)])).toEqual([['R',['client-id']],['R',['client-id']]]);
  await clearPendingPublishes(); expect(runtimeDisk.size).toBe(0);
});
test('an_upload_finishing_after_account_switch_cannot_publish_under_the_new_account',async()=>{
  await runtimeSession(); runtimePosts.length=0;
  let release; engineWait=()=>new Promise(r=>release=r);
  const {encryptedUpload} = await import('./encrypted-upload');
  const uploading=encryptedUpload(uploadOptions);
  for(let i=0;i<30&&!release;i++)await Promise.resolve(); expect(typeof release).toBe('function');
  await runtimeSession('next-account');
  release({id:'previous-account-file',parent_id:'R'});await uploading;engineWait=null;
  await retryPending(); expect(runtimePosts).toEqual([]);
  await clearPendingPublishes();
});

test('an_unavailable_retry_cache_does_not_stop_immediate_publishing',async()=>{
  const s=setup();s.p.read=async()=>{throw Error('cache unreadable');};s.p.write=async()=>{throw Error('cache unwritable');};
  const a=createSharedFolderPublisher(s.p);a.onOwnerUpload({id:'f',parent_id:'R'});await a.idle();
  expect(s.posts).toHaveLength(1);
});

// L7c: a publish happens only for a folder whose custody this account opened, so a later 404, 405 or
// 501 is a server claim to distrust, not proof the folder is gone: the wrap stays queued, never dropped.
test('a_later_404_405_or_501_never_drops_a_queued_wrap_and_it_publishes_once_the_server_answers',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);
  for(const code of [404,405,501]){s.setStatus(code);a.onOwnerUpload({id:`f${code}`,parent_id:'R'});await a.idle();}
  expect(JSON.parse(s.disk()).map(r=>r.fileId).sort()).toEqual(['f404','f405','f501']);
  s.setStatus(0);await a.retryPending();expect(JSON.parse(s.disk())).toEqual([]);
  s.setStatus(404);a.onOwnerUpload({id:'old',parent_id:'R'});await a.idle();s.advance(8*DAY);await a.retryPending();expect(JSON.parse(s.disk())).toEqual([]);
});
test('an_unavailable_custody_keeps_the_wrap_queued_and_posts_nothing',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);
  s.p.folderHandleFor=async()=>{throw Object.assign(new Error("This folder's keys are unavailable"),{name:'CustodyUnavailableError'});};
  a.onOwnerUpload({id:'f',parent_id:'R'});await a.idle();
  expect(s.posts).toEqual([]);expect(s.wraps()).toBe(0);expect(JSON.parse(s.disk())).toEqual([{fileId:'f',parentId:'R',rootId:'R',createdAt:1000}]);
});

// L11: a 409 upgrade_required on a publish is the owner-must-convert state, not a transient failure.
test('a_409_upgrade_required_drops_the_batch_and_remembers_the_folder_instead_of_retrying_for_seven_days',async()=>{
  const ROOT='eeeeeeee-0000-4000-8000-00000000000e';
  const s=setup(ROOT),a=createSharedFolderPublisher(s.p);
  s.p.publish=async()=>{s.posts.push(1);throw Object.assign(Error('refused'),{status:409,code:'upgrade_required'});};
  a.onOwnerUpload({id:'f',parent_id:'sub'});await a.idle();
  expect(s.posts).toHaveLength(1);expect(JSON.parse(s.disk())).toEqual([]);
  expect(await s.p.custody.isUpgradeRequired(ROOT)).toBe(true);
  s.advance(1000);await a.retryPending();expect(s.posts).toHaveLength(1); // nothing left to retry
});
test('other_409s_are_retried_like_any_failure',async()=>{
  const s=setup(),a=createSharedFolderPublisher(s.p);s.p.publish=async()=>{s.posts.push(1);throw Object.assign(Error('x'),{status:409,code:'something_else'});};
  a.onOwnerUpload({id:'f',parent_id:'sub'});await a.idle();
  expect(JSON.parse(s.disk())).toEqual([{fileId:'f',parentId:'sub',rootId:'R',createdAt:1000}]);
});
