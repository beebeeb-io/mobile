import { accountEpoch, onAccountEpochAdvance, sameAccountEpoch } from './account-epoch';
import { isOwnerWrapLoaded, sharedFileKeyIsLoaded, sharedMasterHandleId } from './shared-folder-keys';

export interface AdoptionPorts {
  loaded(id: string): boolean; fromOwnerWrap(id: string): boolean;
  wrap(id: string): Promise<Uint8Array>; post(id: string, b64: string): Promise<{ adopted: boolean }>;
  read(): Promise<string | null>; write(value: string): Promise<void>; remove(): Promise<void>; current(): boolean;
}
export function createSharedFolderAdopter(p: AdoptionPorts) {
  const adopted = new Set<string>(), attempted = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const queue: (() => void)[] = [];
  let active = 0, generation = 0, stopped = false, hydrated: Promise<void> | null = null, writes = Promise.resolve();
  const valid = (g: number) => !stopped && g === generation && p.current();
  function hydrate(): Promise<void> {
    if (!hydrated) { const g=generation; hydrated=(async()=>{try { const raw=await p.read(); if(!valid(g)||!raw)return; const ids:unknown=JSON.parse(raw); if(Array.isArray(ids)) for(const id of ids.slice(0,100000)) if(typeof id==='string')adopted.add(id); } catch {} })(); }
    return hydrated;
  }
  function save(g: number): Promise<void> {
    writes=writes.catch(()=>{}).then(async()=>{if(valid(g))await p.write(JSON.stringify([...adopted]));}); return writes;
  }
  function pump() { while(active<4 && queue.length) { active++; queue.shift()!(); } }
  function enqueue(id: string, g: number): Promise<void> {
    const existing=pending.get(id); if(existing)return existing;
    const task=new Promise<void>(resolve=>{queue.push(()=>{void (async()=>{
      try {
        if(!valid(g)||!p.loaded(id)||adopted.has(id)||attempted.has(id))return;
        attempted.add(id);
        if(!p.fromOwnerWrap(id)) {
          const wrap=await p.wrap(id); if(!valid(g))return;
          if(wrap.length!==60) return;
          await p.post(id,btoa(String.fromCharCode(...wrap))); if(!valid(g))return;
        }
        adopted.add(id); await save(g);
      } catch { /* An adoption failure never blocks opening; retry next session. */ }
      finally { active--; pending.delete(id); resolve(); pump(); }
    })();});});
    pending.set(id,task); pump(); return task;
  }
  return {
    async adoptVerified(ids: string[]): Promise<void> { try { const g=generation; await hydrate(); if(!valid(g))return; await Promise.all([...new Set(ids)].map(id=>enqueue(id,g))); } catch {} },
    isAdopted(id: string): boolean { return adopted.has(id); },
    invalidate() { generation++; stopped=true; adopted.clear(); attempted.clear(); },
    async clearAdopted(): Promise<void> { generation++; stopped=true; adopted.clear(); attempted.clear(); await Promise.all([...pending.values()]); await writes.catch(()=>{}); await p.remove().catch(()=>{}); },
  };
}

export async function adoptDecryptedNames(
  items: { fileId: string }[], results: { name: string | null; error: string | null }[],
  adopt: (ids: string[]) => Promise<void> = adoptVerified,
): Promise<void> {
  await adopt(items.filter((_,i)=>results[i]?.name != null && !results[i]?.error).map(item=>item.fileId));
}

type Adopter = ReturnType<typeof createSharedFolderAdopter>;
let current: Promise<Adopter | null> | null = null;
const instances = new Set<Adopter>();
onAccountEpochAdvance(()=>{for(const a of instances)a.invalidate();current=null;});
async function defaultAdopter(): Promise<Adopter | null> {
  if(current)return current;
  const epoch=accountEpoch(); if(!epoch.accountId)return null;
  current=(async()=>{
    const fs=await import('expo-file-system/legacy');
    const native=await import('../../modules/beebeeb-crypto') as unknown as { sharedAdoptWrap(m: number, id: string): Promise<Uint8Array> };
    const api=await import('./api');
    const {accountDigest}=await import('./files-mount-default');
    if(!sameAccountEpoch(epoch,accountEpoch())||!fs.cacheDirectory)return null;
    const path=`${fs.cacheDirectory}shared-adopted-${accountDigest(epoch.accountId!)}.json`;
    const a=createSharedFolderAdopter({
      loaded:sharedFileKeyIsLoaded,fromOwnerWrap:isOwnerWrapLoaded,
      wrap:id=>native.sharedAdoptWrap(sharedMasterHandleId(),id),post:api.adoptOwnerFileKey,
      read:async()=>{const info=await fs.getInfoAsync(path);return info.exists?fs.readAsStringAsync(path):null;},
      write:value=>fs.writeAsStringAsync(path,value),remove:()=>fs.deleteAsync(path,{idempotent:true}),
      current:()=>sameAccountEpoch(epoch,accountEpoch()),
    });
    instances.add(a); return a;
  })();
  return current;
}
export async function adoptVerified(ids: string[]): Promise<void> { try { await (await defaultAdopter())?.adoptVerified(ids); } catch {} }
export function isAdopted(id: string): boolean { return [...instances].some(a=>a.isAdopted(id)); }
export async function clearAdopted(): Promise<void> {
  try { if(current)await current.catch(()=>null); await Promise.all([...instances].map(a=>a.clearAdopted())); instances.clear(); current=null;
    const fs=await import('expo-file-system/legacy'); if(!fs.cacheDirectory)return;
    const names=await fs.readDirectoryAsync(fs.cacheDirectory);
    for(const name of names)if(/^shared-adopted-[a-f0-9]+\.json$/.test(name))await fs.deleteAsync(`${fs.cacheDirectory}${name}`,{idempotent:true});
  } catch {}
}
