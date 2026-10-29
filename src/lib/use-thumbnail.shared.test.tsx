// @ts-nocheck -- render the real hook with C1 native crypto mocked.
import React from 'react';
import {act,create} from 'react-test-renderer';
import {expect,mock,test} from 'bun:test';
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
let nativeReads=0,exports=0,handleDecrypts=0,state;
mock.module('react-native',()=>({Platform:{OS:'ios'}}));
mock.module('expo-modules-core',()=>({requireOptionalNativeModule:()=>({getThumbnail:async()=>{nativeReads++;return {uri:'native://own',source:'cache'};}})}));
const crypto={isUnlocked:true,getMasterKeyHandleId:()=>7,getFileKeyBytes:async()=>{exports++;return new Uint8Array(32);},decryptChunk:async()=>{handleDecrypts++;return new Uint8Array([1]);}};
mock.module('./crypto-context',()=>({useCrypto:()=>crypto}));
const loadedIds=new Set(['foreign']);let resolver=null;
mock.module('./shared-folder-keys',()=>({sharedFileKeyIsLoaded:id=>loadedIds.has(id),getSharedKeyResolver:()=>resolver}));
mock.module('./thumbnail-events',()=>({onThumbnailReady:()=>({remove(){}})}));
mock.module('./thumbnail-cache',()=>({getCachedThumbnail:async()=>null,enqueueThumbnailLoad:async(id,fn)=>fn(id)}));
mock.module('./thumbnail',()=>({cacheLocalThumbnail:async()=>null,fetchDecryptedThumbnailUri:async(_id,decrypt)=>{await decrypt(new Uint8Array(12),new Uint8Array(48));return 'native://foreign';}}));
mock.module('./local-identifier-map',()=>({getLocalIdentifier:()=>null}));
mock.module('./runtime-trace',()=>({recordRuntimeTrace(){}}));
const {useThumbnail}=await import('./use-thumbnail');
const {ingestTree,clearTree}=await import('./shared-folder-tree');
function Harness({id}){state=useThumbnail(id);return null;}
test('thumbnails_for_table_held_files_decrypt_through_the_handle',async()=>{let tree;await act(async()=>{tree=create(<Harness id="foreign"/>);});expect(state.uri).toBe('native://foreign');expect(handleDecrypts).toBe(1);expect(exports).toBe(0);expect(nativeReads).toBe(0);await act(async()=>{tree.update(<Harness id="own"/>);});expect(state.uri).toBe('native://own');expect(nativeReads).toBe(1);await act(async()=>tree.unmount());});

// Review thread (#233, P2): after a relaunch or a lock a shared file can have a cached decrypted name but no loaded native
// key. Known foreign files resolve their key BEFORE the reader is chosen; an unresolved one fails instead of falling to
// the ordinary reader (which would decrypt with the wrong key).
function resetCounters(){nativeReads=0;exports=0;handleDecrypts=0;state=undefined;}
test('a_relaunched_shared_file_resolves_its_key_before_the_reader_is_chosen',async()=>{
  resetCounters();clearTree();ingestTree([{id:'later',acted_via_share_id:'link'}]);const asked=[];
  resolver={ensureLoaded:async ids=>{asked.push(ids);loadedIds.add('later');return new Map([['later','loaded']]);}};
  let tree;await act(async()=>{tree=create(<Harness id="later"/>);});
  expect(asked).toEqual([['later']]);expect(state.uri).toBe('native://foreign');expect(handleDecrypts).toBe(1);expect(nativeReads).toBe(0);expect(exports).toBe(0);
  await act(async()=>{tree.unmount();});loadedIds.delete('later');resolver=null;
});
test('a_shared_file_whose_key_cannot_be_resolved_fails_without_touching_the_ordinary_reader',async()=>{
  resetCounters();clearTree();ingestTree([{id:'later',acted_via_share_id:'link'}]);
  resolver={ensureLoaded:async()=>new Map([['later','custody_unavailable']])};
  let tree;await act(async()=>{tree=create(<Harness id="later"/>);});
  expect(state.failed).toBe(true);expect(state.uri).toBeNull();expect(nativeReads).toBe(0);expect(handleDecrypts).toBe(0);expect(exports).toBe(0);
  await act(async()=>{tree.unmount();});resolver=null;
});
test('an_own_file_never_waits_for_the_resolver',async()=>{
  resetCounters();clearTree();let asked=0;resolver={ensureLoaded:async()=>{asked++;return new Map();}};
  let tree;await act(async()=>{tree=create(<Harness id="mine"/>);});
  expect(asked).toBe(0);expect(nativeReads).toBe(1);expect(state.uri).toBe('native://own');
  await act(async()=>{tree.unmount();});resolver=null;
});
