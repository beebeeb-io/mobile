import { accountEpoch, onAccountEpochAdvance, sameAccountEpoch, StaleAccountError, type AccountEpoch } from './account-epoch';
import { ancestorsOf, clearTree, isForeignSharedFile } from './shared-folder-tree';
import { CustodyUnavailableError, custodyMemory, isCustodyAbsentStatus, settleMissingCustody, type CustodyMemory } from './shared-folder-custody';

export type SharedKeyOutcome = 'loaded' | 'no_shared_root' | 'no_key_row' | 'key_does_not_open' | 'keys_incomplete' | 'update_required' | 'custody_unavailable' | 'stale';
/** Promised C1/C3 Interfaces. These structural ports can be replaced by their exported types after merge. */
export interface SharedKeysNative {
  isSharedKeysNativeReady(): boolean;
  sharedFolderOpenOwnerKey(master: number, root: string, wrapped: Uint8Array): Promise<number>;
  sharedFileKeysLoad(master: number, folder: number, entries: { fileId: string; wrapped: Uint8Array }[]): Promise<{ loaded: string[]; failed: string[] }>;
  sharedFileKeyOpenOwnerWrap(master: number, file: string, wrapped: Uint8Array): Promise<boolean>;
  sharedFileKeyIsLoaded(file: string): boolean;
  sharedFolderDecryptName(folder: number, envelope: string): Promise<string | null>;
  sharedFolderRelease(folder: number): Promise<void>;
  sharedKeysClear(): Promise<void>;
}
export interface SharedKeysApi {
  getSharedFolder(id: string): Promise<{ folder_id: string; role: string; owner_wrapped_folder_key: string | null }>;
  listSharedFolderKeys(id: string, o: { limit: number; cursor: string | null }): Promise<{ keys: { file_id: string; encrypted_file_key: string }[]; next_cursor: string | null }>;
  getFileOwnerWrap(id: string): Promise<{ ownerWrap: Uint8Array | null; actedViaShareId: string | null }>;
  listFolderLinks(id?: string): Promise<{ id: string; folder_id: string; label_encrypted?: string | null; revoked_at?: string | null }[]>;
}
export interface SharedKeyPorts extends SharedKeysApi { native: SharedKeysNative; custody: CustodyMemory; masterHandleId(): number; epoch(): AccountEpoch; now(): number; }
export interface SharedKeyResolver {
  ensureLoaded(ids: string[]): Promise<Map<string, SharedKeyOutcome>>;
  folderHandleFor(root: string): Promise<number | null>;
  adoptFolderHandle(root: string, handle: number): void;
  originLabel(file: string): Promise<string | null>;
  clear(): void;
}
export function parseOwnerWrap(value: unknown): Uint8Array | null {
  try {
    const bytes = typeof value === 'string' ? Uint8Array.from(atob(value), c => c.charCodeAt(0))
      : Array.isArray(value) && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? new Uint8Array(value) : null;
    return bytes?.length === 60 ? bytes : null;
  } catch { return null; }
}
export function isKeyMismatchError(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? '');
  return /decryption failed|authentication failed|aead(?:error| error)|invalidtag|invalid tag|failed to decrypt|decrypt(?:ion)? error/i.test(message);
}
export class SharedFileKeyNotExportableError extends Error { constructor() { super('Shared file keys stay in native memory'); this.name = 'SharedFileKeyNotExportableError'; } }
let nativeSurface: Partial<SharedKeysNative> = {};
let resolver: SharedKeyResolver | null = null;
let nativeMaster: (() => number) | null = null;
export function sharedMasterHandleId(): number { if (!nativeMaster) throw new Error('Vault is locked'); return nativeMaster(); }
const ownerWrapLoaded = new Set<string>();
const outcomes = new Map<string, SharedKeyOutcome>();
export function isOwnerWrapLoaded(id: string): boolean { return ownerWrapLoaded.has(id); }
export function sharedFileKeyIsLoaded(id: string): boolean { return nativeSurface.sharedFileKeyIsLoaded?.(id) ?? false; }
export function assertFileKeyExportable(id: string, loaded = sharedFileKeyIsLoaded): void { if (loaded(id)) throw new SharedFileKeyNotExportableError(); }
export function setSharedKeyResolver(value: SharedKeyResolver | null): void { resolver = value; }
export function getSharedKeyResolver(): SharedKeyResolver | null { return resolver; }
export function sharedKeyOutcome(id: string): SharedKeyOutcome | undefined { return outcomes.get(id); }
export function clearSharedKeys(): void { nativeMaster = null; resolver?.clear(); clearTree(); outcomes.clear(); ownerWrapLoaded.clear(); }
onAccountEpochAdvance(clearSharedKeys);
export function configureSharedKeys(native: Partial<SharedKeysNative>, api: SharedKeysApi, masterHandleId: () => number): SharedKeyResolver {
  nativeSurface = native;
  clearSharedKeys();
  const r = createSharedKeyResolver({ ...api, native: { ...native, isSharedKeysNativeReady: () => native.isSharedKeysNativeReady?.() ?? false } as SharedKeysNative, masterHandleId, custody: custodyMemory, epoch: accountEpoch, now: Date.now });
  nativeMaster = masterHandleId; setSharedKeyResolver(r); return r;
}

export function createSharedKeyResolver(p: SharedKeyPorts): SharedKeyResolver {
  const roots = new Map<string, number>(), negative = new Map<string, number>();
  const listings = new Map<string, { at: number; rows: Map<string, Uint8Array>; incomplete: boolean }>();
  const rootByFile = new Map<string, string>(), shareByFile = new Map<string, string>();
  const opening = new Map<string, Promise<number | null>>();
  let generation = 0;
  function guard(epoch: AccountEpoch, g: number): void { if (g !== generation || !sameAccountEpoch(epoch, p.epoch())) throw new StaleAccountError('shared keys'); }
  async function folderHandleFor(root: string): Promise<number | null> {
    if (roots.has(root)) return roots.get(root)!;
    // A cached "no custody" verdict is re-checked against the device memory: it must not hide a folder seen since.
    if ((negative.get(root) ?? 0) > p.now()) { await settleMissingCustody(p.custody, root); return null; }
    if (opening.has(root)) return opening.get(root)!;
    const epoch = p.epoch(), g = generation;
    const task = (async () => {
      let info;
      try { info = await p.getSharedFolder(root); guard(epoch, g); }
      catch (e) {
        guard(epoch,g);
        if (!isCustodyAbsentStatus((e as {status?:number}).status)) throw e;
        // L7d: 404/405/501 is "no custody" only for a folder this DEVICE never saw custody for.
        await settleMissingCustody(p.custody, root); guard(epoch,g);
        negative.set(root,p.now()+300000); return null;
      }
      const wrap = parseOwnerWrap(info.owner_wrapped_folder_key);
      // Owner-side only: a custody record that is not the owner's (or does not parse) reads as legacy for a folder
      // never seen, and is refused for one seen before. A member's read of someone else's folder never lands here.
      if (info.role !== 'owner' || !wrap) { await settleMissingCustody(p.custody, root); guard(epoch,g); negative.set(root,p.now()+300000); return null; }
      let handle: number;
      try { handle = await p.native.sharedFolderOpenOwnerKey(p.masterHandleId(), root, wrap); }
      catch (e) { guard(epoch,g); if (await p.custody.hasSeen(root)) throw new CustodyUnavailableError(); throw e; }
      // Open, then markSeen, then use (sharedFileKeysLoad): durable BEFORE the folder key is used, and a record
      // that cannot be stored is not used (its handle is released).
      try { guard(epoch,g); await p.custody.markSeen(root); guard(epoch,g); }
      catch(e) { void p.native.sharedFolderRelease(handle).catch(()=>{}); throw e; }
      roots.set(root,handle); return handle;
    })();
    opening.set(root,task);
    try { return await task; } finally { if (opening.get(root) === task) opening.delete(root); }
  }
  async function listing(root: string, epoch: AccountEpoch, g: number) {
    const cached = listings.get(root); if (cached && p.now()-cached.at < 30000) return cached;
    const rows = new Map<string, Uint8Array>(); let cursor: string | null = null, incomplete = false;
    for (let page = 0; page < 200; page++) {
      const response = await p.listSharedFolderKeys(root,{limit:1000,cursor}); guard(epoch,g);
      if (response.keys.length > 1000 || rows.size + response.keys.length > 100000) { incomplete=true; break; }
      for (const row of response.keys) { const wrap=parseOwnerWrap(row.encrypted_file_key); if(wrap) rows.set(row.file_id,wrap); }
      cursor=response.next_cursor; if(!cursor) break; if(page===199) incomplete=true;
    }
    const value={at:p.now(),rows,incomplete}; listings.set(root,value); return value;
  }
  async function ensureLoaded(ids: string[]): Promise<Map<string,SharedKeyOutcome>> {
    const epoch=p.epoch(), g=generation, out=new Map<string,SharedKeyOutcome>(), groups=new Map<string,string[]>();
    async function ownerFallback(id: string, fallback: SharedKeyOutcome) {
      const row=await p.getFileOwnerWrap(id); guard(epoch,g);
      if(row.actedViaShareId) shareByFile.set(id,row.actedViaShareId);
      if(row.ownerWrap) {
        const opened=await p.native.sharedFileKeyOpenOwnerWrap(p.masterHandleId(),id,row.ownerWrap); guard(epoch,g);
        if(opened) { ownerWrapLoaded.add(id); out.set(id,'loaded'); return; }
      }
      out.set(id,fallback);
    }
    try {
      if(!p.native.isSharedKeysNativeReady()) { ids.forEach(id=>out.set(id,'update_required')); return out; }
      for(const id of new Set(ids)) {
        if(p.native.sharedFileKeyIsLoaded(id)) { out.set(id,'loaded'); continue; }
        let root: string | undefined, refused = false;
        try { for(const ancestor of ancestorsOf(id)) { const handle=await folderHandleFor(ancestor); guard(epoch,g); if(handle!==null) { root=ancestor; break; } } }
        catch(e) { if(!(e instanceof CustodyUnavailableError)) throw e; refused = true; }
        if(refused) { out.set(id,'custody_unavailable'); continue; }
        if(!root) { await ownerFallback(id,'no_shared_root'); continue; }
        rootByFile.set(id,root); const group=groups.get(root)??[]; group.push(id); groups.set(root,group);
      }
      for(const [root,files] of groups) {
        const keys=await listing(root,epoch,g);
        if(keys.incomplete) { files.forEach(id=>out.set(id,'keys_incomplete')); continue; }
        const entries=files.filter(id=>keys.rows.has(id)).map(fileId=>({fileId,wrapped:keys.rows.get(fileId)!}));
        if(entries.length) {
          const loaded=await p.native.sharedFileKeysLoad(p.masterHandleId(),roots.get(root)!,entries); guard(epoch,g);
          entries.forEach(e=>out.set(e.fileId,loaded.loaded.includes(e.fileId)?'loaded':'key_does_not_open'));
        }
        for(const id of files) if(!keys.rows.has(id)) await ownerFallback(id,'no_key_row');
      }
    } catch(e) {
      const stale = e instanceof StaleAccountError || g!==generation || !sameAccountEpoch(epoch,p.epoch());
      for(const id of ids) if(stale || !out.has(id)) out.set(id,stale?'stale':'key_does_not_open');
    }
    if(g===generation && sameAccountEpoch(epoch,p.epoch())) for(const [id,result] of out) outcomes.set(id,result);
    return out;
  }
  return {
    ensureLoaded, folderHandleFor,
    adoptFolderHandle(root,handle) { const old=roots.get(root); if(old!==undefined && old!==handle) void p.native.sharedFolderRelease(old).catch(()=>{}); roots.set(root,handle); negative.delete(root); },
    async originLabel(id) {
      const epoch=p.epoch(),g=generation,root=rootByFile.get(id); if(!root) return null;
      try {
        let share=shareByFile.get(id);
        if(!share) { const row=await p.getFileOwnerWrap(id); guard(epoch,g); share=row.actedViaShareId??undefined; }
        if(!share) return null;
        const links=await p.listFolderLinks(root); guard(epoch,g); const label=links.find(l=>l.id===share)?.label_encrypted;
        if(!label) return null; const value=await p.native.sharedFolderDecryptName(roots.get(root)!,label); guard(epoch,g); return value;
      } catch { return null; }
    },
    clear() { generation++; roots.clear(); negative.clear(); listings.clear(); rootByFile.clear(); shareByFile.clear(); opening.clear(); outcomes.clear(); ownerWrapLoaded.clear(); void p.native.sharedKeysClear?.().catch(()=>{}); },
  };
}

export async function retrySharedDecrypt<T>(id: string, operation: () => Promise<T>, r = resolver): Promise<T> {
  const epoch=accountEpoch();
  try {
    const value = await operation();
    if (!sameAccountEpoch(epoch, accountEpoch())) throw new StaleAccountError('shared decrypt');
    return value;
  } catch(error) {
    if(!r || !isKeyMismatchError(error)) throw error;
    const result=await r.ensureLoaded([id]);
    if(result.get(id)==='stale' || !sameAccountEpoch(epoch,accountEpoch())) throw new StaleAccountError('shared decrypt');
    if(result.get(id)!=='loaded') throw error;
    const value = await operation();
    if (!sameAccountEpoch(epoch, accountEpoch())) throw new StaleAccountError('shared decrypt');
    return value;
  }
}
export async function resolveSharedNames<T extends {fileId:string}, R extends {error:string|null}>(items: T[], decrypt: (items:T[])=>Promise<R[]>, r=resolver): Promise<R[]> {
  const epoch=accountEpoch();
  // L3: known foreign rows resolve before touching native readers.
  const foreign=items.filter(i=>isForeignSharedFile(i.fileId,epoch.accountId));
  if(foreign.length && r) { const loaded=await r.ensureLoaded(foreign.map(i=>i.fileId)); if([...loaded.values()].includes('stale') || !sameAccountEpoch(epoch,accountEpoch())) throw new StaleAccountError('shared names'); }
  const result=await decrypt(items);
  if (!sameAccountEpoch(epoch, accountEpoch())) throw new StaleAccountError('shared names');
  const failed=items.filter((_,i)=>isKeyMismatchError(result[i]?.error));
  if(!failed.length || !r) return result;
  const loaded=await r.ensureLoaded(failed.map(i=>i.fileId));
  if([...loaded.values()].includes('stale') || !sameAccountEpoch(epoch,accountEpoch())) throw new StaleAccountError('shared names');
  const retry=failed.filter(i=>loaded.get(i.fileId)==='loaded'); if(!retry.length) return result;
  const values=await decrypt(retry); if(!sameAccountEpoch(epoch,accountEpoch())) throw new StaleAccountError('shared names');
  const byId=new Map(retry.map((item,i)=>[item.fileId,values[i]])); return items.map((item,i)=>byId.get(item.fileId)??result[i]);
}
