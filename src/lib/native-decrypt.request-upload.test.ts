// @ts-nocheck -- isolated Bun harness; the native bridge is modeled, not JNI-executed.
import { beforeEach, expect, mock, test } from 'bun:test';
import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fixture from './request-upload-v1.fixture.json';

const bytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const decrypt = (key, nonce, ciphertext) => {
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAuthTag(ciphertext.slice(-16));
  return new Uint8Array(Buffer.concat([d.update(ciphertext.slice(0, -16)), d.final()]));
};
const unwrap = () => decrypt(hkdfSync('sha256', bytes(fixture.masterKey), new Uint8Array(), 'beebeeb-file-request-priv-v1', 32), bytes(fixture.wrap_nonce), bytes(fixture.wrapped_private_key));
const open = (privateKey, publicKey, wrapped) => {
  const priv = createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'), privateKey]),format:'der',type:'pkcs8'});
  const pub = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'), publicKey]),format:'der',type:'spki'});
  const shared = diffieHellman({privateKey:priv,publicKey:pub});
  const key = hkdfSync('sha256', shared, new Uint8Array(), 'beebeeb-file-request-seal-v1', 32);
  return decrypt(key, wrapped.slice(0,12), wrapped.slice(12));
};
const files = new Map();
let current = fixture.files[0], masterCalls = 0, requestKeyCalls = 0, offline = false;
mock.module('expo-file-system/legacy',()=>({
 cacheDirectory:'file:///cache/',EncodingType:{Base64:'base64',UTF8:'utf8'},
 getInfoAsync:async uri=>uri.endsWith('/')?{exists:true}:files.has(uri)?{exists:true,size:files.get(uri).length}:{exists:false},
 makeDirectoryAsync:async()=>{},readDirectoryAsync:async()=>[],deleteAsync:async uri=>{files.delete(uri);},
 writeAsStringAsync:async(uri,data)=>{files.set(uri,bytes(data));},readAsStringAsync:async uri=>Buffer.from(files.get(uri)).toString('base64'),
}));
mock.module('../../modules/beebeeb-crypto',()=>({
 isNativeAvailable:true,
 decryptLocalFileNative:undefined,
 // Real native derives from the master key (or, on iOS, rejects the null handle).
 // This deterministic failure must NEVER be reached for a request content key.
 downloadAndDecryptFileNative:async()=>{masterCalls++;throw new Error('wrong master-derived file key');},
 streamVideoNative:async()=>{throw new Error('must not stream a request with the master key');},
 decryptChunk:async(key,nonce,ciphertext)=>decrypt(key,nonce,ciphertext),
 unwrapRequestPrivateWithHandle:async()=>unwrap(),
 openRequestUpload:async(priv,pub,wrapped)=>open(priv,pub,wrapped),
}));
mock.module('./decrypt-to-file',()=>({isDecryptToFileReady:()=>false,DecryptToFileUnavailableError:class extends Error{},decryptChunksToFile:async()=>{throw new Error('unavailable');}}));
mock.module('./api',()=>({ApiError:class extends Error{},getApiUrl:()=>'',getDownloadUrl:()=>'',getToken:async()=>'test',friendlyError:e=>String(e),listFileRequests:async()=>({file_requests:[{id:fixture.files[0].file_request_id,wrapped_private_key:fixture.wrapped_private_key,wrap_nonce:fixture.wrap_nonce}]})}));
mock.module('./rate-limited-fetch',()=>({rateLimitedFetch:async()=>new Response(bytes(current.frame),{headers:{'Content-Length':String(bytes(current.frame).length),'X-Original-Size':String(bytes(current.plaintext).length),'X-Chunk-Count':'1'}})}));
mock.module('./runtime-trace',()=>({recordRuntimeTrace:()=>{}}));
mock.module('@react-native-community/netinfo',()=>({default:{fetch:async()=>({isConnected:!offline})}}));
mock.module('./offline-manager',()=>({offlineManager:{init:async()=>{},isAvailable:()=>offline,getMeta:()=>({sizeBytes:bytes(current.plaintext).length,chunkCount:1})},offlineFilePath:()=> 'file:///encrypted'}));
const {decryptToTempFile,releasePreviewCopy} = await import('./native-decrypt');
const {createRequestKeyResolver} = await import('./file-request-crypto');
const {plaintextGate} = await import('./plaintext-gate');
const {encryptedMetadataPayloadToBytes} = await import('./encrypted-metadata');
const resolver = createRequestKeyResolver(()=>7);
beforeEach(()=>{files.clear();masterCalls=0;requestKeyCalls=0;offline=false;resolver.clear();plaintextGate.open();});
for(const file of fixture.files) {
 test(`2236 ${file.name}: existing web-sealed upload opens original bytes with request content key`,async()=>{
   current=file;
   const key=()=>{requestKeyCalls++;return resolver.resolveContentKey(file);};
   const uri=await decryptToTempFile(file.id,key,file.name.split('.').pop(),bytes(file.plaintext).length,1,null,{useProvidedFileKey:true});
   expect(masterCalls).toBe(0);expect(requestKeyCalls).toBe(1);
   expect(createHash('sha256').update(files.get(uri)).digest('hex')).toBe(file.sha256);
   await releasePreviewCopy(file.id,file.name.split('.').pop());
 });
 test(`2236 ${file.name}: existing canonical metadata names and routes the file`,async()=>{
   const contentKey = await resolver.resolveContentKey(file);
   const metadata = encryptedMetadataPayloadToBytes(file.name_encrypted);
   expect(metadata).not.toBeNull();
   const plaintext = decrypt(contentKey,metadata.nonce,metadata.ciphertext);
   expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({name:file.name,mime_type:file.mime});
 });
 test(`2236 ${file.name}: pinned offline ciphertext uses the same request key`,async()=>{
   current=file;offline=true;files.set('file:///encrypted',bytes(file.frame));
   const uri=await decryptToTempFile(file.id,()=>resolver.resolveContentKey(file),file.name.split('.').pop(),bytes(file.plaintext).length,1,null,{useProvidedFileKey:true});
   expect(masterCalls).toBe(0);expect(createHash('sha256').update(files.get(uri)).digest('hex')).toBe(file.sha256);
   await releasePreviewCopy(file.id,file.name.split('.').pop());
 });
}
test('2236 normal relaunch with a null handle still resolves the master key natively',async()=>{
 await expect(decryptToTempFile('normal',()=>{throw new Error('must stay native');},'md',45,1,null)).rejects.toThrow('wrong master-derived file key');
 expect(masterCalls).toBe(1);
});
test('2236 request content authentication failure is not retried using the master key',async()=>{
 current={...fixture.files[0],frame:Buffer.from(bytes(fixture.files[0].frame).map((v,i)=>i===13?v^1:v)).toString('base64')};
 await expect(decryptToTempFile('tampered',()=>resolver.resolveContentKey(current),'md',bytes(current.plaintext).length,1,null,{useProvidedFileKey:true})).rejects.toThrow();
 expect(masterCalls).toBe(0);expect(files.has('file:///cache/preview/tampered.md')).toBe(false);
});
test('2236 JPEG preview and direct/PDF/save routes explicitly carry request key mode',()=>{
 const preview=readFileSync(new URL('../screens/PreviewScreen.tsx',import.meta.url),'utf8');
 const filesScreen=readFileSync(new URL('../screens/FilesScreen.tsx',import.meta.url),'utf8');
 expect(preview.includes('is_request_upload: !!requestFileFields && currentFileId === fileId')).toBe(true);
 expect(preview.includes('useProvidedFileKey: entry.is_request_upload === true')).toBe(true);
 expect(preview.includes('getPreviewFileKeyBytes,')).toBe(true);
 expect(preview.match(/useProvidedFileKey: !!requestFileFields && currentFileId === fileId/g)?.length).toBe(2);
 expect(filesScreen.includes('useProvidedFileKey: requestUpload')).toBe(true);
});

for (const size of [null,101*1024*1024]) {
 test(`2236 supplied-key mode retains the memory bound for size ${size}`,async()=>{
  current=fixture.files[0];
  await expect(decryptToTempFile('bounded-'+size,()=>resolver.resolveContentKey(current),'md',size,1,null,{useProvidedFileKey:true})).rejects.toThrow('too large');
  expect(masterCalls).toBe(0);
 });
}
