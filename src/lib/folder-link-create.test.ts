// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { beforeEach, expect, mock, test } from 'bun:test';
// MARKED MOCKS: C1 Task 3 native constructors and C2 Task 5 tree/resolver,
// per their Interfaces blocks. No native interoperability is claimed here.
mock.module('../../modules/beebeeb-crypto', () => ({}));
mock.module('./api', () => ({}));
mock.module('./file-request-crypto', () => ({
  toBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
  fromBase64: (s: string) => new Uint8Array(Buffer.from(s, 'base64')),
  toBase64url: (b: Uint8Array) => Buffer.from(b).toString('base64url'),
}));
const { createFolderLinkWithKeys: create, recoverLinkUrl, FolderKeyUnverifiedError, FolderTooLargeError, FolderPassphraseError } = await import('./folder-link-create');
const input = { folderId: 'folder', accessLevel: 'add', label: 'Family', expiresInHours: null, capBytes: null, passphrase: null };
const wrap = new Uint8Array(60).fill(3);
const calls: string[] = [];
let ports: any;
let random = 0;
beforeEach(() => {
  calls.length = 0; random = 0;
  ports = {
    masterHandleId: () => 7,
    getWebAppUrl: () => 'https://example.test',
    subtreeIds: () => ['a', 'b'],
    getSharedFolder: async () => { calls.push('custody'); throw { status: 404 }; },
    getSentInvites: async () => [],
    registerSharedFolderKey: async () => { calls.push('register'); return { key_version: 1 }; },
    publishSharedFolderKeys: async (_f, keys) => { calls.push(`publish:${keys.length}`); return { written: keys.length, skipped: 0 }; },
    createFolderLink: async body => { calls.push('create'); return { id: 'link', token: body.token, key_version: 1 }; },
    native: {
      isSharedKeysNativeReady: () => true,
      sharedFolderGenerate: async () => { calls.push('generate'); return { handleId: 8, ownerWrapped: wrap }; },
      sharedFolderOpenOwnerKey: async () => { calls.push('open'); return 9; },
      sharedFolderRelease: async id => { calls.push(`release:${id}`); },
      sharedWrapChildKeys: async (_m, _h, ids) => ids.map(fileId => ({ fileId, wrapped: wrap })),
      folderLinkMint: async (_m, _h, token, passphrase) => { calls.push('mint'); return { kc: 'K'.repeat(43), wrappedFolderKey: wrap, ownerWrappedKey: wrap, ownerWrappedToken: wrap }; },
      sharedFolderEncryptName: async () => '{"ciphertext":"sealed"}',
      generateRandomBytes: async () => new Uint8Array(32).fill(++random),
      folderLinkRecoverKc: async () => 'K'.repeat(43),
      unwrapForOwnerWithHandle: async () => new TextEncoder().encode('A'.repeat(43)),
    },
  };
});
test('custody_is_registered_before_wraps_before_the_link', async () => {
  await create(input, ports);
  expect(calls.indexOf('register')).toBeLessThan(calls.indexOf('publish:2'));
  expect(calls.indexOf('publish:2')).toBeLessThan(calls.indexOf('create'));
  expect(calls.at(-1)).toBe('release:8');
});
test('existing_custody_is_never_overwritten', async () => {
  ports.getSharedFolder = async () => ({ role: 'owner', owner_wrapped_folder_key: Buffer.from(wrap).toString('base64'), key_version: 4 });
  const result = await create(input, ports);
  expect(calls).toContain('open'); expect(calls).not.toContain('generate'); expect(calls).not.toContain('register');
  expect(result.keyVersion).toBe(1); // create response is authoritative
});
test('invite_held_key_is_reused_and_registered_as_custody', async () => {
  ports.getSentInvites = async () => [{ file_id: 'folder', is_folder_share: true, status: 'approved', created_at: '2026-10-28', encrypted_owner_folder_key: 'Aw==' }];
  await create(input, ports); expect(calls).toContain('open'); expect(calls).toContain('register'); expect(calls).not.toContain('generate');
});
test('unopenable_invites_never_mint_a_replacement_key', async () => {
  ports.getSentInvites = async () => [{ file_id: 'folder', is_folder_share: true, status: 'claimed', encrypted_owner_folder_key: 'Aw==' }];
  ports.native.sharedFolderOpenOwnerKey = async () => { throw new Error('cannot open'); };
  await expect(create(input, ports)).rejects.toBeInstanceOf(FolderKeyUnverifiedError); expect(calls).not.toContain('generate');
});
test('409_key_version_conflict_rereads_and_opens_the_stored_key', async () => {
  let reads = 0;
  ports.getSharedFolder = async () => { if (++reads === 1) throw { status: 404 }; return { role: 'owner', owner_wrapped_folder_key: 'Aw==', key_version: 2 }; };
  ports.registerSharedFolderKey = async () => { throw { status: 409, code: 'key_version_conflict' }; };
  await create(input, ports); expect(reads).toBe(2); expect(calls).toContain('release:8'); expect(calls).toContain('open'); expect(calls.at(-1)).toBe('release:9');
});
test('wraps_go_in_batches_of_1000_and_progress_is_reported', async () => {
  ports.subtreeIds = () => Array.from({ length: 2500 }, (_, i) => `i${i}`);
  const progress: number[] = []; await create({ ...input, onProgress: p => progress.push(p.done) }, ports);
  expect(calls.filter(c => c.startsWith('publish'))).toEqual(['publish:1000', 'publish:1000', 'publish:500']);
  expect(progress).toEqual([1000, 2000, 2500]);
});
test('over_100000_ids_is_refused_before_any_request', async () => {
  ports.subtreeIds = () => Array.from({ length: 100001 }, (_, i) => `${i}`);
  await expect(create(input, ports)).rejects.toBeInstanceOf(FolderTooLargeError); expect(calls).toEqual([]);
});
test('request_uploads_are_excluded_from_wraps', async () => {
  // C2 subtreeIds owns filtering. This mock pins that C3 uses that port,
  // never a fresh unfiltered listing or a per-file JS key derivation.
  const tree = [{ id: 'normal', file_request_id: null }, { id: 'request', file_request_id: 'r' }];
  ports.subtreeIds = () => tree.filter(r => !r.file_request_id).map(r => r.id);
  let wrapped: string[] = []; ports.native.sharedWrapChildKeys = async (_m, _h, ids) => { wrapped = ids; return ids.map(fileId => ({ fileId, wrapped: wrap })); };
  await create(input, ports); expect(wrapped).toEqual(['normal']);
});
test('token_is_43_chars_base64url_and_a_token_taken_409_remints_once', async () => {
  const tokens: string[] = [];
  ports.createFolderLink = async body => { tokens.push(body.token); if (tokens.length === 1) throw { status: 409, code: 'token_taken' }; return { id: 'l', token: body.token, key_version: 1 }; };
  const result = await create(input, ports); expect(tokens).toHaveLength(2); expect(tokens[0]).not.toBe(tokens[1]);
  expect(tokens.every(t => /^[A-Za-z0-9_-]{43}$/.test(t))).toBe(true); expect(result.url).toBe(`https://example.test/f/${tokens[1]}#key=${'K'.repeat(43)}`);
});
test('passphrase_link_sends_the_passphrase_only_for_the_verify_gate', async () => {
  let mintArgs: any[]; let body: any;
  const mint = ports.native.folderLinkMint; ports.native.folderLinkMint = async (...args) => { mintArgs = args; return mint(...args); };
  ports.createFolderLink = async b => { body = b; return { id: 'l', token: b.token, key_version: 1 }; };
  await create({ ...input, passphrase: 'test-only phrase' }, ports);
  expect(mintArgs[3]).toBe('test-only phrase'); expect(mintArgs[2]).toBe(body.token); expect(body.passphrase).toBe('test-only phrase');
  expect(body).not.toHaveProperty('kc'); expect(JSON.stringify(body)).not.toContain('K'.repeat(43));
});
test('a_mobile_made_link_recovers_the_same_url', async () => {
  const url = await recoverLinkUrl({ owner_wrapped_token: Buffer.from(wrap).toString('base64'), owner_wrapped_key: Buffer.from(wrap).toString('base64') }, 8, ports);
  expect(url).toBe(`https://example.test/f/${'A'.repeat(43)}#key=${'K'.repeat(43)}`);
});
test('a_web_made_link_never_yields_a_url', async () => {
  ports.native.folderLinkRecoverKc = async () => null;
  expect(await recoverLinkUrl({ owner_wrapped_token: Buffer.from(wrap).toString('base64'), owner_wrapped_key: Buffer.from(wrap).toString('base64') }, 8, ports)).toBeNull();
});
test('too_many_links_is_surfaced_with_the_exact_line', async () => {
  ports.createFolderLink = async () => { throw { status: 409, code: 'too_many_links' }; };
  await expect(create(input, ports)).rejects.toThrow('A folder can have at most 20 links.');
});
test('a_failed_stretch_is_typed_and_never_downgrades_the_link', async () => {
  ports.native.folderLinkMint = async () => { throw new Error('allocation failure'); };
  await expect(create({ ...input, passphrase: 'test-only phrase' }, ports)).rejects.toBeInstanceOf(FolderPassphraseError);
  expect(calls).not.toContain('create');
});
test('cancel_stops_between_batches_and_releases_the_handle', async () => {
  ports.subtreeIds = () => Array.from({ length: 1500 }, (_, i) => `${i}`);
  const controller = new AbortController();
  await expect(create({ ...input, signal: controller.signal, onProgress: () => controller.abort() }, ports)).rejects.toHaveProperty('name', 'AbortError');
  expect(calls.filter(c => c.startsWith('publish'))).toEqual(['publish:1000']); expect(calls).not.toContain('create'); expect(calls.at(-1)).toBe('release:8');
});
test('folder_key_missing_reregisters_once_and_retries', async () => {
  let attempts = 0; ports.createFolderLink = async body => { if (++attempts === 1) throw { status: 409, code: 'folder_key_missing' }; return { id: 'l', token: body.token, key_version: 1 }; };
  await create(input, ports); expect(attempts).toBe(2); expect(calls.filter(c => c === 'register')).toHaveLength(2);
});
test('account_change_after_custody_prevents_publishing', async () => {
  const { advanceAccountEpoch } = await import('./account-epoch');
  ports.registerSharedFolderKey = async () => { advanceAccountEpoch(); return { key_version: 1 }; };
  await expect(create(input, ports)).rejects.toHaveProperty('name', 'StaleAccountError'); expect(calls).not.toContain('publish:2');
});
