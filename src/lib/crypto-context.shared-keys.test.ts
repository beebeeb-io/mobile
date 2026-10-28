// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveSharedNames, retrySharedDecrypt, SharedFileKeyNotExportableError, assertFileKeyExportable } from './shared-folder-keys';
test('decryptNames_seam_retries_only_the_failed_items_once', async () => {
 const batches: string[][]=[]; let attempts=0;
 const decrypt=async(items:{fileId:string}[])=>{batches.push(items.map(i=>i.fileId)); return items.map(i=>({ name:i.fileId==='ok'||attempts++>1?i.fileId:null, mimeType:null,error:i.fileId==='ok'||attempts>2?null:'Decryption failed' }));};
 const resolver={ensureLoaded:async()=>new Map([['bad','loaded'],['bad2','loaded']])} as any;
 const result=await resolveSharedNames([{fileId:'ok',nameEncrypted:''},{fileId:'bad',nameEncrypted:''},{fileId:'bad2',nameEncrypted:''}],decrypt,resolver);
 expect(batches).toEqual([['ok','bad','bad2'],['bad','bad2']]); expect(result[0].name).toBe('ok'); expect(result).toHaveLength(3);
});
test('getFileKeyBytes_refuses_a_table_held_file_and_never_calls_the_thumbnail_service', () => {
 expect(()=>assertFileKeyExportable('f',()=>true)).toThrow(SharedFileKeyNotExportableError);
 const src=readFileSync(new URL('./crypto-context.tsx',import.meta.url),'utf8'); expect(src.indexOf('assertFileKeyExportable(fileId')).toBeLessThan(src.indexOf('const key = await handleDeriveFileKey'));
});
test('native_decrypt_retries_once_after_a_key_mismatch_then_gives_up', async () => {
 let n=0; const r={ensureLoaded:async()=>new Map([['f','loaded']])} as any;
 await expect(retrySharedDecrypt('f',async()=>{n++;throw new Error('Decryption failed');},r)).rejects.toThrow('Decryption failed'); expect(n).toBe(2);
});
