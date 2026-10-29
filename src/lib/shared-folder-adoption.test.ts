// @ts-nocheck -- persistence and C1 bridge are explicit ports.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createSharedFolderAdopter, adoptDecryptedNames } from './shared-folder-adoption';
function setup() {
 let disk=null, posts:string[]=[], active=0,max=0,fail=false; const ownerWrap=new Set<string>();
 const p={loaded:()=>true,fromOwnerWrap:id=>ownerWrap.has(id),wrap:async()=>new Uint8Array(60).fill(2),post:async(id,b64)=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;if(fail)throw Error('500');posts.push(id);expect(atob(b64).length).toBe(60);return {adopted:false};},read:async()=>disk,write:async value=>{disk=value;},remove:async()=>{disk=null;},current:()=>true};
 return {p,posts,ownerWrap,disk:()=>disk,max:()=>max,fail:()=>{fail=true;}};
}
test('adopts_only_after_the_name_opened',async()=>{const s=setup(),a=createSharedFolderAdopter(s.p);await adoptDecryptedNames([{fileId:'ok'},{fileId:'bad'}],[{name:'Photo',error:null},{name:null,error:'Decryption failed'}],a.adoptVerified);expect(s.posts).toEqual(['ok']);});
test('adoption_posts_the_owner_wrap_and_no_raw_key',async()=>{const s=setup(),a=createSharedFolderAdopter(s.p);await a.adoptVerified(['f']);expect(s.posts).toEqual(['f']);expect(JSON.parse(s.disk())).toEqual(['f']);});
test('adoption_is_write_once_per_device_and_survives_a_relaunch',async()=>{const s=setup(),a=createSharedFolderAdopter(s.p);await a.adoptVerified(['f']);await a.adoptVerified(['f']);await createSharedFolderAdopter(s.p).adoptVerified(['f']);expect(s.posts).toEqual(['f']);});
test('adoption_failure_never_blocks_opening_and_is_retried_next_session',async()=>{const s=setup();s.fail();const a=createSharedFolderAdopter(s.p);await expect(a.adoptVerified(['f'])).resolves.toBeUndefined();expect(a.isAdopted('f')).toBe(false);let n=0;s.p.post=async()=>{n++;return {adopted:true};};await createSharedFolderAdopter(s.p).adoptVerified(['f']);expect(n).toBe(1);});
test('adoption_concurrency_is_four',async()=>{const s=setup();await createSharedFolderAdopter(s.p).adoptVerified(Array.from({length:10},(_,i)=>String(i)));expect(s.max()).toBe(4);expect(s.posts).toHaveLength(10);});
test('owner_wrap_loaded_ids_are_marked_adopted_without_a_post',async()=>{const s=setup();s.ownerWrap.add('f');const a=createSharedFolderAdopter(s.p);await a.adoptVerified(['f']);expect(a.isAdopted('f')).toBe(true);expect(s.posts).toEqual([]);});
test('adopted_set_is_purged_on_sign_out',async()=>{const s=setup(),a=createSharedFolderAdopter(s.p);await a.adoptVerified(['f']);await a.clearAdopted();expect(a.isAdopted('f')).toBe(false);expect(s.disk()).toBeNull();expect(readFileSync(new URL('./account-cleanup.ts',import.meta.url),'utf8').includes('clearAdopted()')).toBe(true);});
test('a_late_adoption_response_cannot_recreate_a_purged_set',async()=>{const s=setup();let release;s.p.post=async()=>{await new Promise(r=>release=r);return {adopted:true};};const a=createSharedFolderAdopter(s.p);const task=a.adoptVerified(['f']);for(let i=0;i<10&&!release;i++)await Promise.resolve();const purge=a.clearAdopted();release();await task;await purge;expect(s.disk()).toBeNull();expect(a.isAdopted('f')).toBe(false);});
