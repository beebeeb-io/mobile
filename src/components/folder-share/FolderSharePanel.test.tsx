// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { afterEach, beforeEach, expect, mock, test, spyOn } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Primitives below preserve testIDs and accessible copy.
mock.module('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner', StyleSheet: { create: x => x } }));
mock.module('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
mock.module('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: (...args) => navigations.push(args) }) }));
mock.module('../../lib/theme-context', () => ({ useTheme: () => ({ colors: { paper: '#fff', paper2: '#eee', ink: '#111', ink2: '#333', ink3: '#555', ink4: '#777', line: '#ddd', amber: '#eeb000', red: '#c00' } }) }));
mock.module('../sheet/BottomSheet', () => ({ BottomSheetScrollView: 'ScrollView' }));
const masterHandleId = () => 7;
mock.module('../../lib/crypto-context', () => ({ useCrypto: () => ({ getMasterKeyHandleId: masterHandleId, isUnlocked: true }) }));
let links: any[];
let patches: any[];
let revoked: string[];
let copied: string[];
let clipboard = '';
let navigations: any[];
let recover: () => Promise<string | null>;
let create: (input: any) => Promise<any>;
let createInputs: any[];
let members: any[];
mock.module('expo-clipboard', () => ({ setStringAsync: async text => { clipboard = text; copied.push(text); }, getStringAsync: async () => clipboard }));
mock.module('../../lib/api', () => ({
  listFolderLinks: async () => links,
  getFolderMembers: async () => ({ members, owner_id: 'owner', folder_id: 'folder' }),
  updateFolderLink: async (id, patch) => { patches.push([id, patch]); links = links.map(l => l.id === id ? { ...l, ...patch } : l); return links.find(l => l.id === id); },
  revokeFolderLink: async id => { revoked.push(id); },
  friendlyError: () => 'Please try again.',
}));
// MARKED MOCK: C2 Task 5 resolver plus C1 Task 3 label decryption.
mock.module('../../lib/shared-folder-keys', () => ({ getSharedKeyResolver: () => ({ folderHandleFor: async () => 8 }) }));
class FolderPassphraseError extends Error { name = 'FolderPassphraseError'; }
mock.module('../../lib/folder-link-create', () => ({
  FolderPassphraseError,
  createFolderLinkPorts: () => ({ native: {} }),
  folderLinkNative: { sharedFolderDecryptName: async () => 'Family' },
  recoverLinkUrl: async () => recover(),
  createFolderLinkWithKeys: async input => { createInputs.push(input); return create(input); },
}));
const { FolderSharePanel } = await import('./FolderSharePanel');
let renderer: any;
let timerSpy: any;
const link = (id = 'l') => ({ id, folder_id: 'folder', access_level: 'add', label_encrypted: '{"sealed":true}', expires_at: null, max_opens: null, open_count: 0, download_count: 0, paused: false, cap_bytes: null, cap_used_bytes: 0, passphrase_protected: false, created_at: '2026-10-28', revoked_at: null });
beforeEach(() => {
  links = [link()]; patches = []; revoked = []; copied = []; navigations = []; createInputs = [];
  members = [{ user_id: 'owner', email: 'me@example.test', role: 'owner', is_owner: true, access_level: 'edit' }, { user_id: 'member', email: 'member@example.test', role: 'member', access_level: 'view' }];
  recover = async () => 'https://example.test/f/token#key=key';
  create = async () => ({ id: 'new', url: 'https://example.test/f/new#key=key' });
});
afterEach(async () => { timerSpy?.mockRestore(); timerSpy = null; if (renderer) await act(async () => renderer.unmount()); renderer = null; });
async function mount() { await act(async () => { renderer = TestRenderer.create(<FolderSharePanel folderId="folder" folderName="Photos" onClose={() => {}} />); }); }
const id = name => renderer.root.findByProps({ testID: name });
const text = () => JSON.stringify(renderer.toJSON());
async function press(name) { await act(async () => { const node = id(name); if (!node.props.disabled) await node.props.onPress(); }); }
async function change(name, value) { await act(async () => id(name).props.onChangeText(value)); }
test('flag_on_renders_owner_member_and_link_rows_in_one_list', async () => {
  await mount(); expect(text()).toContain('You (owner)'); expect(text()).toContain('member@example.test'); expect(text()).toContain('Family'); expect(id('folder-link-row-l')).toBeDefined();
  await press('folder-link-activity'); expect(navigations).toEqual([['SharedFolderActivity', { folderId: 'folder' }]]);
});
test('level_chips_map_to_copy_and_default_is_add', async () => {
  await mount(); expect(id('folder-link-level-add').props.accessibilityState.selected).toBe(true);
  for (const [level, copy] of [['view', 'Can view'], ['add', 'Can add'], ['edit', 'Can edit']]) { await press(`folder-link-level-${level}`); expect(id(`folder-link-level-${level}`).props.accessibilityState.selected).toBe(true); expect(text()).toContain(copy); }
  await press('folder-link-create'); expect(createInputs[0].accessLevel).toBe('edit');
});
test('pause_resume_patches_paused_and_updates_the_row', async () => {
  await mount(); await press('folder-link-pause-l'); expect(text()).toContain('Paused'); await press('folder-link-pause-l');
  expect(patches).toEqual([['l', { paused: true }], ['l', { paused: false }]]);
});
test('revoke_needs_two_taps_calls_revoke_once_and_shows_the_honest_limit', async () => {
  await mount(); await press('folder-link-revoke-l'); expect(revoked).toEqual([]); expect(text()).toContain('Revoke link?');
  expect(text()).toContain('Stops the link now. Someone who already saved the folder key could still decrypt files they downloaded.');
  await press('folder-link-revoke-confirm-l'); expect(revoked).toEqual(['l']); expect(text()).not.toContain('folder-link-row-l');
});
test('twenty_links_disable_create_with_the_exact_line', async () => {
  links = Array.from({ length: 20 }, (_, i) => link(`${i}`)); await mount();
  expect(text()).toContain('A folder can have at most 20 links.'); expect(id('folder-link-create').props.disabled).toBe(true);
});
test('a_web_made_link_disables_copy_with_the_reason', async () => {
  recover = async () => null; await mount(); expect(id('folder-link-copy-l').props.disabled).toBe(true);
  expect(text()).toContain('Made on another device. Create a new link to copy it.');
});
test('a_mobile_made_link_copies_the_full_f_url_and_clears_the_clipboard_after_60_seconds', async () => {
  const timers: (() => void)[] = []; const real = globalThis.setTimeout;
  timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms, ...args) => ms === 60000 ? (timers.push(fn), 999) : real(fn, ms, ...args));
  await mount(); await press('folder-link-copy-l'); expect(copied).toEqual(['https://example.test/f/token#key=key']); expect(timers).toHaveLength(1);
  await act(async () => { await timers[0](); }); expect(copied.at(-1)).toBe('');
});
test('passphrase_creation_shows_securing_and_a_failed_stretch_offers_a_link_without_a_passphrase', async () => {
  let reject!: (e: Error) => void;
  create = input => { input.onProgress({ phase: 'securing', done: 0, total: 1 }); return new Promise((_r, fail) => { reject = fail; }); };
  await mount(); await change('folder-link-passphrase', 'test-only phrase');
  await act(async () => { void id('folder-link-create').props.onPress(); }); expect(text()).toContain('Securing');
  await act(async () => reject(new FolderPassphraseError('memory'))); expect(text()).toContain('Create without a passphrase'); expect(createInputs).toHaveLength(1);
  create = async () => ({ id: 'new', url: 'https://example.test/f/new#key=key' }); await press('folder-link-without-passphrase'); expect(createInputs[1].passphrase).toBeNull();
});
test('create_shows_preparing_progress_and_cancel_stops_between_batches', async () => {
  let reject!: (e: Error) => void;
  create = input => { input.onProgress({ phase: 'preparing', done: 1000, total: 2500 }); return new Promise((_r, fail) => { reject = fail; }); };
  await mount(); await act(async () => { void id('folder-link-create').props.onPress(); }); expect(text()).toContain('1000 of 2500');
  await press('folder-link-cancel'); expect(createInputs[0].signal.aborted).toBe(true);
  const err = new Error('cancelled'); err.name = 'AbortError'; await act(async () => reject(err)); expect(text()).not.toContain('Please try again.');
});
test('a_501_returns_to_the_bundle_sheet', async () => {
  let fallback = 0; create = async () => { throw { status: 501 }; };
  await act(async () => { renderer = TestRenderer.create(<FolderSharePanel folderId="folder" folderName="Photos" onClose={() => {}} onUnavailable={() => fallback++} />); });
  await press('folder-link-create'); expect(fallback).toBe(1);
});
