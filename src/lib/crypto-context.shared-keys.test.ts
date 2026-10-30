// @ts-nocheck -- Bun test harness, matching the isolated suite convention.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveSharedNames, retrySharedDecrypt, SharedFileKeyNotExportableError, assertFileKeyExportable } from './shared-folder-keys';
import { nonForeignFileIds } from './shared-folder-tree';
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
test('decryptNamesFn_declares_exactly_the_non_foreign_ids', async () => {
 // Pure half: a row the tree marks foreign is never declared owned; an own row is.
 const { ingestTree, clearTree } = await import('./shared-folder-tree');
 clearTree();
 ingestTree([
  { id: 'own-1', uploaded_by: 'me' },
  { id: 'foreign-1', acted_via_share_id: 'share-1' },
  { id: 'foreign-2', uploaded_by: 'someone-else' },
  { id: 'foreign-3', owner_wrapped_file_key: 'abc' },
 ]);
 expect(nonForeignFileIds([{ fileId: 'own-1' }, { fileId: 'foreign-1' }, { fileId: 'foreign-2' }, { fileId: 'foreign-3' }], 'me'))
  .toEqual(['own-1']);
 clearTree();
 // Seam: the crypto context declares those ids to the native batch.
 const src = readFileSync(new URL('./crypto-context.tsx', import.meta.url), 'utf8');
 expect(src).toContain('nonForeignFileIds(items, accountEpoch().accountId)');
 expect(src).toMatch(/decryptNames\(requireHandleId\(\), batch, [A-Za-z]+\)/);
});

test('a_successful_metadata_open_is_discarded_after_an_account_switch', async () => {
 const {advanceAccountEpoch}=await import('./account-epoch');
 await expect(retrySharedDecrypt('f',async()=>{advanceAccountEpoch();return 'previous-account metadata';},null)).rejects.toThrow('account changed');
});
test('a_successful_name_batch_is_discarded_after_an_account_switch', async () => {
 const {advanceAccountEpoch}=await import('./account-epoch');
 await expect(resolveSharedNames([{fileId:'f'}],async()=>{advanceAccountEpoch();return [{name:'previous-account name',error:null}];},null)).rejects.toThrow('account changed');
});
test('a_successful_metadata_retry_is_discarded_after_an_account_switch', async () => {
 const {advanceAccountEpoch}=await import('./account-epoch'); let attempts=0;
 await expect(retrySharedDecrypt('f',async()=>{if(!attempts++)throw Error('Decryption failed');advanceAccountEpoch();return 'previous-account metadata';},{ensureLoaded:async()=>new Map([['f','loaded']])})).rejects.toThrow('account changed');
});
