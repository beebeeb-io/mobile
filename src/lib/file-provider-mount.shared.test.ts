// @ts-nocheck
import { expect, mock, test } from 'bun:test';
let sent=[];
mock.module('react-native',()=>({Platform:{OS:'ios'}}));
mock.module('../../modules/beebeeb-crypto',()=>({syncFileProviderCache:async entries=>{sent=entries;return entries.length;}}));
mock.module('./api',()=>({getApiUrl:()=>'',getToken:async()=>null,listAllFiles:async()=>[]}));
mock.module('./device-owner-auth',()=>({requestDeviceOwnerAuth:async()=>true}));
mock.module('./lock-state',()=>({wasRecentlyUnlocked:()=>true}));
mock.module('./shared-folder-keys',()=>({sharedFileKeyIsLoaded:id=>id==='foreign'}));
const {syncDecryptedEntriesToFileProvider}=await import('./file-provider-mount');
const {plaintextGate}=await import('./plaintext-gate');
test('file_provider_feed_skips_table_held_ids',async()=>{plaintextGate.open();await syncDecryptedEntriesToFileProvider([{id:'own'},{id:'foreign'}],{});expect(sent.map(e=>e.id)).toEqual(['own']);});
