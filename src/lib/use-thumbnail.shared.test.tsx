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
mock.module('./shared-folder-keys',()=>({sharedFileKeyIsLoaded:id=>id==='foreign',getSharedKeyResolver:()=>null}));
mock.module('./thumbnail-events',()=>({onThumbnailReady:()=>({remove(){}})}));
mock.module('./thumbnail-cache',()=>({getCachedThumbnail:async()=>null,enqueueThumbnailLoad:async(id,fn)=>fn(id)}));
mock.module('./thumbnail',()=>({cacheLocalThumbnail:async()=>null,fetchDecryptedThumbnailUri:async(_id,decrypt)=>{await decrypt(new Uint8Array(12),new Uint8Array(48));return 'native://foreign';}}));
mock.module('./local-identifier-map',()=>({getLocalIdentifier:()=>null}));
mock.module('./runtime-trace',()=>({recordRuntimeTrace(){}}));
const {useThumbnail}=await import('./use-thumbnail');
function Harness({id}){state=useThumbnail(id);return null;}
test('thumbnails_for_table_held_files_decrypt_through_the_handle',async()=>{let tree;await act(async()=>{tree=create(<Harness id="foreign"/>);});expect(state.uri).toBe('native://foreign');expect(handleDecrypts).toBe(1);expect(exports).toBe(0);expect(nativeReads).toBe(0);await act(async()=>{tree.update(<Harness id="own"/>);});expect(state.uri).toBe('native://own');expect(nativeReads).toBe(1);await act(async()=>tree.unmount());});
