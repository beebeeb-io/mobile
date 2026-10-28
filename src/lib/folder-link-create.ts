import * as Crypto from '../../modules/beebeeb-crypto';
import * as api from './api';
import { fromBase64, toBase64, toBase64url } from './file-request-crypto';
import { buildFullShareLink } from './share-full-link';
import { linkErrorCode, type FolderAccessLevel, type FolderLink, type SharedFolderInfo } from './folder-link-types';
import { accountEpoch, isCurrentAccountEpoch, StaleAccountError } from './account-epoch';

// C1 Task 3 Interfaces, pending merge. Tests use MARKED MOCKS; no JS key fallback.
export interface FolderLinkNative {
  isSharedKeysNativeReady(): boolean;
  sharedFolderOpenOwnerKey(master: number, folder: string, wrapped: Uint8Array): Promise<number>;
  sharedFolderGenerate(master: number, folder: string): Promise<{ handleId: number; ownerWrapped: Uint8Array }>;
  sharedFolderRelease(handle: number): Promise<void>;
  sharedWrapChildKeys(master: number, folder: number, ids: string[]): Promise<{ fileId: string; wrapped: Uint8Array }[]>;
  sharedFolderEncryptName(handle: number, text: string): Promise<string>;
  sharedFolderDecryptName(handle: number, envelope: string): Promise<string | null>;
  folderLinkMint(master: number, folder: number, token: string, passphrase: string | null): Promise<{ kc: string; wrappedFolderKey: Uint8Array; ownerWrappedKey: Uint8Array; ownerWrappedToken: Uint8Array }>;
  folderLinkRecoverKc(master: number, folder: number, wrapped: Uint8Array): Promise<string | null>;
  unwrapForOwnerWithHandle(master: number, wrapped: Uint8Array, nonce: Uint8Array): Promise<Uint8Array>;
  generateRandomBytes(size: number): Promise<Uint8Array>;
}
export const folderLinkNative = Crypto as unknown as FolderLinkNative;
export interface CreateFolderLinkInput {
  folderId: string;
  accessLevel: FolderAccessLevel;
  label: string | null;
  expiresInHours: number | null;
  capBytes: number | null;
  passphrase: string | null;
  onProgress?: (p: { phase: 'preparing' | 'securing'; done: number; total: number }) => void;
  signal?: AbortSignal;
}
export interface CreatedLink { id: string; token: string; url: string; level: FolderAccessLevel; passphraseProtected: boolean; keyVersion: number }
export interface CreateFolderLinkPorts {
  masterHandleId(): number;
  native: FolderLinkNative;
  subtreeIds(rootId: string): string[];
  getSharedFolder: typeof api.getSharedFolder;
  getSentInvites: typeof api.getSentInvites;
  registerSharedFolderKey: typeof api.registerSharedFolderKey;
  publishSharedFolderKeys: typeof api.publishSharedFolderKeys;
  createFolderLink: typeof api.createFolderLink;
  getWebAppUrl: typeof api.getWebAppUrl;
}
export type RecoverPorts = Pick<CreateFolderLinkPorts, 'masterHandleId' | 'native' | 'getWebAppUrl'>;
/** The UI binds the existing CryptoProvider handle; never re-read the Keychain. */
export function createFolderLinkPorts(masterHandleId: () => number): CreateFolderLinkPorts {
  return {
    masterHandleId, native: folderLinkNative,
    // C2 Task 5 Interfaces, pending merge. No substitute tree or key derivation.
    subtreeIds: rootId => (require('./shared-folder-tree') as { subtreeIds(id: string): string[] }).subtreeIds(rootId),
    getSharedFolder: api.getSharedFolder, getSentInvites: api.getSentInvites,
    registerSharedFolderKey: api.registerSharedFolderKey,
    publishSharedFolderKeys: api.publishSharedFolderKeys,
    createFolderLink: api.createFolderLink, getWebAppUrl: api.getWebAppUrl,
  };
}
const unboundPorts = () => createFolderLinkPorts(() => { throw new Error('Unlock Beebeeb to manage folder links.'); });
export class FolderKeyUnverifiedError extends Error {
  constructor() { super("Can't check this folder's key. Create this link on the web."); this.name = 'FolderKeyUnverifiedError'; }
}
export class FolderTooLargeError extends Error {
  constructor() { super('This folder has more than 100,000 items.'); this.name = 'FolderTooLargeError'; }
}
export class FolderPassphraseError extends Error {
  constructor() { super("This device couldn't secure the link with a passphrase. Try again, or choose to create a link without a passphrase."); this.name = 'FolderPassphraseError'; }
}
export class FolderLinksUnavailableError extends Error {
  readonly status = 501;
  readonly code = 'shared_folders_v1';
  constructor() { super('Update Beebeeb to manage folder links.'); this.name = 'FolderLinksUnavailableError'; }
}
function statusOf(err: unknown): number | undefined { return (err as { status?: number } | null)?.status; }
function codeOf(err: unknown): string | undefined { return (err as { code?: string } | null)?.code; }

export async function createFolderLinkWithKeys(input: CreateFolderLinkInput, ports: CreateFolderLinkPorts = unboundPorts()): Promise<CreatedLink> {
  const epoch = accountEpoch();
  const assertCurrent = () => {
    if (!isCurrentAccountEpoch(epoch)) throw new StaleAccountError('Folder link');
    if (input.signal?.aborted) { const err = new Error('Link creation cancelled.'); err.name = 'AbortError'; throw err; }
  };
  const checked = async <T,>(work: Promise<T>): Promise<T> => { const value = await work; assertCurrent(); return value; };
  assertCurrent();
  // Local, request-free size preflight enforces the plan's 100,000-item bound.
  const ids = [...new Set(ports.subtreeIds(input.folderId))];
  if (ids.length > 100_000) throw new FolderTooLargeError();
  if (!ports.native.isSharedKeysNativeReady?.()) throw new FolderLinksUnavailableError();
  const master = ports.masterHandleId();
  let handle: number | null = null;
  let ownerWrapped: Uint8Array;
  let keyVersion = 1;
  const openCustody = async (info: SharedFolderInfo) => {
    if (info.role !== 'owner' || !info.owner_wrapped_folder_key) throw new FolderKeyUnverifiedError();
    ownerWrapped = fromBase64(info.owner_wrapped_folder_key);
    keyVersion = info.key_version;
    // Assign before checking epoch so finally releases a late native result too.
    handle = await ports.native.sharedFolderOpenOwnerKey(master, input.folderId, ownerWrapped);
    assertCurrent();
  };
  try {
    let info: SharedFolderInfo | null;
    try { info = await checked(ports.getSharedFolder(input.folderId)); }
    catch (err) { assertCurrent(); if (statusOf(err) !== 404) throw err; info = null; }
    if (info) {
      await openCustody(info);
    } else {
      const invites = (await checked(ports.getSentInvites())).filter(row => row.is_folder_share && row.file_id === input.folderId && ['invited', 'claimed', 'approved'].includes(row.status))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      if (invites.length) {
        for (const invite of invites) {
          if (!invite.encrypted_owner_folder_key) continue;
          try {
            const wrapped = fromBase64(invite.encrypted_owner_folder_key);
            handle = await ports.native.sharedFolderOpenOwnerKey(master, input.folderId, wrapped);
            assertCurrent(); ownerWrapped = wrapped; break;
          } catch (err) { assertCurrent(); if (handle !== null) throw err; }
        }
        if (handle === null) throw new FolderKeyUnverifiedError();
      } else {
        const generated = await ports.native.sharedFolderGenerate(master, input.folderId);
        handle = generated.handleId; ownerWrapped = generated.ownerWrapped; assertCurrent();
      }
      try {
        await checked(ports.registerSharedFolderKey(input.folderId, { owner_wrapped_folder_key: toBase64(ownerWrapped!), key_version: keyVersion }));
      } catch (err) {
        assertCurrent();
        if (statusOf(err) !== 409 || codeOf(err) !== 'key_version_conflict') throw err;
        await ports.native.sharedFolderRelease(handle!); handle = null; assertCurrent();
        await openCustody(await checked(ports.getSharedFolder(input.folderId)));
      }
    }
    for (let offset = 0; offset < ids.length; offset += 1000) {
      assertCurrent();
      const batch = ids.slice(offset, offset + 1000);
      const entries = await checked(ports.native.sharedWrapChildKeys(master, handle!, batch));
      if (entries.length !== batch.length || new Set(entries.map(row => row.fileId)).size !== batch.length || entries.some(row => !batch.includes(row.fileId))) {
        throw new Error("Couldn't prepare all the folder's keys. Try again.");
      }
      await checked(ports.publishSharedFolderKeys(input.folderId, entries.map(row => ({ file_id: row.fileId, encrypted_file_key: toBase64(row.wrapped) }))));
      input.onProgress?.({ phase: 'preparing', done: offset + batch.length, total: ids.length });
    }
    assertCurrent();
    const label = input.label?.trim();
    let tokenRetried = false;
    let custodyRetried = false;
    let token = toBase64url(await checked(ports.native.generateRandomBytes(32)));
    for (;;) {
      assertCurrent();
      if (input.passphrase) input.onProgress?.({ phase: 'securing', done: 0, total: 1 });
      let mint: Awaited<ReturnType<FolderLinkNative['folderLinkMint']>>;
      try { mint = await checked(ports.native.folderLinkMint(master, handle!, token, input.passphrase)); }
      catch (err) { assertCurrent(); if (input.passphrase) throw new FolderPassphraseError(); throw err; }
      const labelEncrypted = label ? await checked(ports.native.sharedFolderEncryptName(handle!, label.slice(0, 40))) : undefined;
      try {
        const result = await checked(ports.createFolderLink({
          folder_id: input.folderId, token, access_level: input.accessLevel,
          wrapped_folder_key: toBase64(mint.wrappedFolderKey), owner_wrapped_key: toBase64(mint.ownerWrappedKey), owner_wrapped_token: toBase64(mint.ownerWrappedToken),
          ...(labelEncrypted ? { label_encrypted: labelEncrypted } : {}),
          ...(input.expiresInHours !== null ? { expires_in_hours: input.expiresInHours } : {}),
          ...(input.capBytes !== null ? { cap_bytes: input.capBytes } : {}),
          ...(input.passphrase ? { passphrase: input.passphrase } : {}),
        }));
        return { id: result.id, token, url: buildFullShareLink(ports.getWebAppUrl(), token, mint.kc, 'f'), level: input.accessLevel, passphraseProtected: !!input.passphrase, keyVersion: result.key_version };
      } catch (err) {
        assertCurrent();
        const code = linkErrorCode(err);
        if (code === 'token_taken' && !tokenRetried) {
          tokenRetried = true; token = toBase64url(await checked(ports.native.generateRandomBytes(32))); continue;
        }
        if (code === 'folder_key_missing' && !custodyRetried) {
          custodyRetried = true;
          await checked(ports.registerSharedFolderKey(input.folderId, { owner_wrapped_folder_key: toBase64(ownerWrapped!), key_version: keyVersion }));
          continue;
        }
        if (code === 'too_many_links') throw new Error('A folder can have at most 20 links.');
        if (code === 'nested_share') throw new Error('This folder is already inside a shared folder.');
        throw err;
      }
    }
  } finally {
    if (handle !== null) await ports.native.sharedFolderRelease(handle).catch(() => {});
  }
}

export async function recoverLinkUrl(link: FolderLink, folderHandleId: number, ports: RecoverPorts = unboundPorts()): Promise<string | null> {
  if (!link.owner_wrapped_token || !link.owner_wrapped_key) return null;
  const epoch = accountEpoch();
  let clear: Uint8Array | null = null;
  try {
    const master = ports.masterHandleId();
    const blob = fromBase64(link.owner_wrapped_token);
    if (blob.length < 29) return null;
    clear = await ports.native.unwrapForOwnerWithHandle(master, blob.slice(12), blob.slice(0, 12));
    if (!isCurrentAccountEpoch(epoch)) return null;
    const token = new TextDecoder('utf-8', { fatal: true }).decode(clear);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const kc = await ports.native.folderLinkRecoverKc(master, folderHandleId, fromBase64(link.owner_wrapped_key));
    if (!isCurrentAccountEpoch(epoch) || !kc || !/^[A-Za-z0-9_-]{43}$/.test(kc)) return null;
    return buildFullShareLink(ports.getWebAppUrl(), token, kc, 'f');
  } catch { return null; }
  finally { clear?.fill(0); }
}
