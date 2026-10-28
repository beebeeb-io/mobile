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
const { createCustodyMemory, CustodyUnavailableError, UpgradeRequiredError } = await import('./shared-folder-custody');
const { setExpectedUserId } = await import('./expected-user');
const { createFolderLinkWithKeys: create, recoverLinkUrl, FolderKeyUnverifiedError, FolderTooLargeError, FolderPassphraseError } = await import('./folder-link-create');
const FOLDER = '11111111-2222-4333-8444-555555555555', PARENT = '99999999-8888-4777-8666-555555555555';
const input = { folderId: FOLDER, accessLevel: 'add', label: 'Family', expiresInHours: null, capBytes: null, passphrase: null };
const wrap = new Uint8Array(60).fill(3);
const calls: string[] = [];
let ports: any;
let random = 0;
// The Keychain behind the custody memory: a Map, so a "restart" is a new memory over the same Map.
let keychain: Map<string, string>;
const noMarker = { exists: async () => false, write: async () => {} };
const memoryOver = (map: Map<string, string>) => createCustodyMemory({ get: async k => map.get(k) ?? null, set: async (k, v) => { map.set(k, v); } }, noMarker);
beforeEach(() => {
  calls.length = 0; random = 0; keychain = new Map(); setExpectedUserId('acct-a');
  ports = {
    custody: memoryOver(keychain), ancestors: () => [],
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
// Review thread (#234, P1; L11, task 2255): an invite for the folder that carries an owner copy of the folder key means
// the folder already has a key. Minting a fresh one splits the key. Any live invite (invited, claimed, pending, approved;
// unknown statuses fail closed) is the same state as the server's 409 upgrade_required: no mint, no seeding.
const invite = (status: string, extra = {}) => ({ file_id: FOLDER, is_folder_share: true, status, created_at: '2026-10-28', encrypted_owner_folder_key: 'Aw==', ...extra });
test('any_live_invite_that_holds_the_folder_key_means_the_folder_needs_the_upgrade_and_never_mints', async () => {
  for (const status of ['invited', 'claimed', 'pending', 'approved', 'some_new_status']) {
    calls.length = 0; keychain.clear(); ports.custody = memoryOver(keychain); ports.getSentInvites = async () => [invite(status)];
    const error = await create(input, ports).catch(e => e);
    expect(error).toBeInstanceOf(UpgradeRequiredError); expect(error.message).toBe('The owner must convert this folder first');
    noWrites(); expect(calls).not.toContain('open'); expect(await ports.custody.isUpgradeRequired(FOLDER)).toBe(true);
  }
});
test('the_upgrade_state_is_remembered_so_a_later_attempt_does_not_read_the_invites_again', async () => {
  ports.getSentInvites = async () => [invite('pending')];
  await expect(create(input, ports)).rejects.toBeInstanceOf(UpgradeRequiredError);
  calls.length = 0; ports.custody = memoryOver(keychain); // a restart: the mark is durable
  ports.getSentInvites = async () => { throw new Error('must not be asked'); };
  await expect(create(input, ports)).rejects.toBeInstanceOf(UpgradeRequiredError); noWrites();
});
test('a_newer_dead_invite_does_not_hide_an_older_live_one', async () => {
  ports.getSentInvites = async () => [invite('denied', { created_at: '2026-10-29' }), invite('pending', { created_at: '2026-10-01' })];
  await expect(create(input, ports)).rejects.toBeInstanceOf(UpgradeRequiredError); noWrites();
});
test('dead_invites_alone_and_other_folders_invites_do_not_block_a_fresh_folder', async () => {
  ports.getSentInvites = async () => [invite('denied'), invite('expired'), invite('cancelled'), invite('pending', { file_id: PARENT }), invite('pending', { is_folder_share: false })];
  await create(input, ports); expect(calls).toContain('generate'); expect(calls).toContain('register');
});
test('a_live_invite_without_an_owner_copy_never_mints_either', async () => {
  ports.getSentInvites = async () => [invite('pending', { encrypted_owner_folder_key: undefined })];
  await expect(create(input, ports)).rejects.toBeInstanceOf(FolderKeyUnverifiedError); noWrites(); expect(calls).not.toContain('open');
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

test('default_ports_bind_the_existing_native_master_handle', async () => {
  // C2 now exposes the existing CryptoProvider handle without a Keychain read.
  mock.module('./shared-folder-keys', () => ({ sharedMasterHandleId: () => 7 }));
  const { createFolderLinkPorts } = await import('./folder-link-create');
  expect(createFolderLinkPorts().masterHandleId()).toBe(7);
});

// L7c / L10 / L11 (plan C, contract-2237-format-l7.md): custody is one-way; no fresh key over a seen
// or upgrade-required folder; 409 upgrade_required is its own honest state, never a legacy retry.
const custodyRecord = () => ({ role: 'owner', owner_wrapped_folder_key: Buffer.from(wrap).toString('base64'), key_version: 1 });
const noWrites = () => { for (const c of ['generate', 'register', 'mint', 'create']) expect(calls).not.toContain(c); expect(calls.some(c => c.startsWith('publish'))).toBe(false); };
test('a_seen_folder_that_later_answers_404_405_or_501_never_mints_a_fresh_key', async () => {
  ports.getSharedFolder = async () => custodyRecord(); await create(input, ports); // custody seen and opened
  for (const status of [404, 405, 501]) {
    calls.length = 0; ports = { ...ports, custody: memoryOver(keychain), getSharedFolder: async () => { calls.push('custody'); throw { status }; } };
    await expect(create(input, ports)).rejects.toBeInstanceOf(CustodyUnavailableError); noWrites();
  }
});
test('a_never_seen_folder_answering_405_or_501_is_a_folder_without_custody_like_404', async () => {
  for (const status of [405, 501]) {
    calls.length = 0; keychain.clear(); ports.custody = memoryOver(keychain); ports.getSharedFolder = async () => { throw { status }; };
    await create(input, ports); expect(calls).toContain('generate'); expect(calls).toContain('register');
  }
});
test('custody_is_recorded_durably_before_any_wrap_is_published_when_it_was_opened_or_registered', async () => {
  for (const existing of [true, false]) {
    keychain.clear(); ports.custody = memoryOver(keychain); let seenAtPublish: boolean | null = null;
    ports.getSharedFolder = async () => { if (existing) return custodyRecord(); throw { status: 404 }; };
    ports.publishSharedFolderKeys = async (_f, keys) => { seenAtPublish = await ports.custody.hasSeen(FOLDER); return { written: keys.length, skipped: 0 }; };
    await create(input, ports); expect(seenAtPublish).toBe(true);
  }
});
test('a_custody_record_that_cannot_be_stored_is_not_used_and_publishes_nothing', async () => {
  const failing = { get: async () => null, set: async () => { throw new Error('keychain'); } };
  ports.custody = createCustodyMemory(failing, noMarker);
  // The server accepted the registration (mark-after-register: a failed mark never wedges a folder that has no custody), but nothing is wrapped or linked.
  await expect(create(input, ports)).rejects.toBeInstanceOf(CustodyUnavailableError);
  for (const c of ['mint', 'create']) expect(calls).not.toContain(c); expect(calls.some(c => c.startsWith('publish'))).toBe(false); expect(calls.at(-1)).toBe('release:8');
  // An existing record that cannot be stored is refused before anything is minted, registered or wrapped.
  calls.length = 0; ports.getSharedFolder = async () => custodyRecord();
  await expect(create(input, ports)).rejects.toBeInstanceOf(CustodyUnavailableError); noWrites(); expect(calls.at(-1)).toBe('release:9');
});
test('409_upgrade_required_on_custody_registration_is_the_upgrade_state_and_blocks_any_later_mint', async () => {
  ports.registerSharedFolderKey = async () => { calls.push('register'); throw { status: 409, code: 'upgrade_required' }; };
  const first = await create(input, ports).catch(e => e); expect(first).toBeInstanceOf(UpgradeRequiredError);
  expect(first.message).toBe('The owner must convert this folder first'); for (const c of ['generate_after', 'mint', 'create']) expect(calls).not.toContain(c); expect(calls.some(c => c.startsWith('publish'))).toBe(false);
  expect(calls.filter(c => c === 'register')).toHaveLength(1); expect(calls.at(-1)).toBe('release:8');
  calls.length = 0; ports.custody = memoryOver(keychain); // restart: the mark is durable
  await expect(create(input, ports)).rejects.toBeInstanceOf(UpgradeRequiredError);
  expect(calls).not.toContain('generate'); expect(calls).not.toContain('register');
});
test('409_upgrade_required_on_the_wrap_publish_or_the_link_create_is_the_upgrade_state', async () => {
  ports.getSharedFolder = async () => custodyRecord();
  ports.publishSharedFolderKeys = async () => { throw { status: 409, code: 'upgrade_required' }; };
  await expect(create(input, ports)).rejects.toBeInstanceOf(UpgradeRequiredError); expect(calls).not.toContain('create');
  calls.length = 0; ports.publishSharedFolderKeys = async (_f, keys) => ({ written: keys.length, skipped: 0 });
  ports.createFolderLink = async () => { throw { status: 409, code: 'upgrade_required' }; };
  await expect(create(input, ports)).rejects.toBeInstanceOf(UpgradeRequiredError); expect(calls).not.toContain('generate'); expect(calls.filter(c => c === 'register')).toHaveLength(0);
});
test('other_409s_are_not_the_upgrade_state', async () => {
  ports.createFolderLink = async () => { throw { status: 409, code: 'nested_share' }; };
  await expect(create(input, ports)).rejects.toThrow('This folder is already inside a shared folder.');
});
test('an_account_switch_does_not_empty_the_device_memory', async () => {
  ports.getSharedFolder = async () => custodyRecord(); await create(input, ports);
  setExpectedUserId('acct-b'); calls.length = 0; ports.custody = memoryOver(keychain); ports.getSharedFolder = async () => { throw { status: 404 }; };
  await expect(create(input, ports)).rejects.toBeInstanceOf(CustodyUnavailableError); noWrites();
});
test('a_folder_inside_a_seen_shared_folder_never_mints_custody_of_its_own', async () => {
  await ports.custody.markSeen(PARENT); ports.ancestors = id => (id === FOLDER ? [PARENT] : []);
  await expect(create(input, ports)).rejects.toThrow('This folder is already inside a shared folder.'); noWrites();
  ports.ancestors = () => []; await create(input, ports); expect(calls).toContain('generate'); // no seen ancestor: unchanged
});
