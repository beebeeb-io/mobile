// @ts-nocheck -- Bun isolated runtime harness, as in native-decrypt.cache-integrity.test.ts.
import { beforeEach, expect, mock, test } from 'bun:test';
const files = new Map<string, Uint8Array>();
const key = new Uint8Array(32).fill(7), nonce = new Uint8Array(12).fill(9);
const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
const tag = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv:nonce}, aes, new Uint8Array()));
const frame = new Uint8Array([...nonce, ...tag]);
let body = frame, nativeFast = false, offline = false, decrypts = 0;
mock.module('expo-file-system/legacy', () => ({
 cacheDirectory:'file:///cache/', EncodingType:{Base64:'base64', UTF8:'utf8'},
 getInfoAsync:async uri => uri.endsWith('/') ? {exists:true} : files.has(uri) ? {exists:true,size:files.get(uri).length} : {exists:false},
 makeDirectoryAsync:async()=>{}, readDirectoryAsync:async()=>[],
 deleteAsync:async uri => { files.delete(uri); },
 writeAsStringAsync:async (uri, data) => { files.set(uri, new Uint8Array(Buffer.from(data, 'base64'))); },
 readAsStringAsync:async (uri, opts) => Buffer.from(files.get(uri) ?? []).toString(opts?.encoding === 'utf8' ? 'utf8' : 'base64'),
}));
mock.module('../../modules/beebeeb-crypto', () => ({
 isNativeAvailable:true, decryptLocalFileNative:undefined, streamVideoNative:undefined,
 downloadAndDecryptFileNative:async()=>{throw new Error("downloadAndDecryptFileNative is not available");},
 decryptChunk:async (_key, iv, ciphertext) => { decrypts++; return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv}, aes, ciphertext)); },
}));
mock.module('./api', () => ({ApiError:class extends Error{}, getApiUrl:()=>'',getDownloadUrl:()=>'',getToken:async()=>'test',friendlyError: e=>String(e)}));
mock.module('./rate-limited-fetch', () => ({rateLimitedFetch:async()=> new Response(body, {headers:{'Content-Length':String(body.length),'X-Original-Size':'0','X-Chunk-Count':'1'}})}));
mock.module('./runtime-trace', () => ({recordRuntimeTrace:()=>{}}));
mock.module('@react-native-community/netinfo', () => ({default:{fetch:async()=>({isConnected:true})}}));
mock.module('./offline-manager', () => ({offlineManager:{init:async()=>{},isAvailable:()=>offline,getMeta:()=>({sizeBytes:0,chunkCount:1})},offlineFilePath:()=> 'file:///encrypted'}));
mock.module('./decrypt-to-file', () => ({
 isDecryptToFileReady:()=>nativeFast, DecryptToFileUnavailableError:class extends Error{},
 decryptChunksToFile:async (_key, encrypted, _chunkSize, path) => {
   const plain = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:encrypted.slice(0,12)}, aes, encrypted.slice(12)));
   decrypts++; files.set(path,plain); return plain.length;
 },
}));
const {decryptToTempFile, decryptLocalFileToTempFile} = await import('./native-decrypt');
const {plaintextGate} = await import('./plaintext-gate');
beforeEach(()=>{files.clear();body=frame;nativeFast=false;offline=false;decrypts=0;plaintextGate.open();});
test('legacy JS download authenticates an empty frame and writes an empty note', async()=>{
 const uri = await decryptToTempFile('empty-js', key, 'txt', 0, 1);
 expect(files.get(uri)?.length).toBe(0); expect(decrypts).toBe(1);
});
test('batched download accepts authenticated zero bytes for an empty note', async()=>{
 nativeFast=true; const uri = await decryptToTempFile('empty-fast', key, 'txt', 0, 1);
 expect(files.get(uri)?.length).toBe(0); expect(decrypts).toBe(1);
});
test('offline encrypted empty note is still authenticated before opening', async()=>{
 files.set('file:///encrypted',frame);
 const uri=await decryptLocalFileToTempFile('empty-offline',key,'txt','file:///encrypted',0,1);
 expect(files.get(uri)?.length).toBe(0); expect(decrypts).toBe(1);
});
test('corrupt tag on an empty note still fails instead of synthesizing success', async()=>{
 body = frame.slice(); body[27]^=1;
 await expect(decryptToTempFile('empty-corrupt',key,'txt',0,1)).rejects.toThrow();
 expect(decrypts).toBe(1); expect(files.has('file:///cache/preview/empty-corrupt.txt')).toBe(false);
});
