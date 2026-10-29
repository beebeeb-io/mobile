// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { beforeEach, expect, mock, test } from 'bun:test';
import { createDecipheriv } from 'node:crypto';
mock.module('./api', () => ({ getSharedFolderActivity: async () => [], listFolderLinks: async () => [] }));
mock.module('./folder-link-create', () => ({ folderLinkNative: {} }));
const { describeActivity, loadFolderActivity, loadAccountFolderActivity } = await import('./folder-activity');
const row = (kind = 'files_added', item_count = 12) => ({ id: kind, kind, item_count, share_id: 'link', share_label_encrypted: 'label', actor_name_encrypted: 'actor', actor_user_id: null, first_at: '2026-10-28', last_at: '2026-10-28' });
let ports: any;
beforeEach(() => { ports = {
  getSharedFolderActivity: async () => [row()],
  listFolderLinks: async () => [],
  folderHandleFor: async () => 8,
  // MARKED MOCK: C1 Task 3 native name reader and C2 Task 5 folder handle.
  sharedFolderDecryptName: async (_handle, envelope) => envelope === 'label' ? 'Family WhatsApp' : 'Alice',
}; });
test('describe_activity_matches_the_copy_for_each_kind', () => {
  expect(describeActivity(row(), 'Family WhatsApp', 'Alice')).toBe('12 files added via Family WhatsApp');
  expect(describeActivity(row('files_added', 1), null, null)).toBe('1 file added');
  expect(describeActivity(row('items_renamed', 2), null, 'Alice')).toBe('2 items renamed by Alice');
  expect(describeActivity(row('items_renamed', 1), null, null)).toBe('1 item renamed by Someone');
  expect(describeActivity(row('items_deleted', 3), null, 'Alice')).toBe('3 items deleted by Alice, restorable from Trash for 30 days');
  expect(describeActivity(row('items_moved'), null, 'Alice')).toBe('Items moved by Alice');
});
test('an_undecryptable_actor_reads_Someone_and_an_undecryptable_label_drops_via', async () => {
  ports.sharedFolderDecryptName = async () => { throw new Error('cannot open'); };
  ports.getSharedFolderActivity = async () => [row('items_deleted', 2), row()];
  const result = await loadFolderActivity('folder', 50, ports);
  expect(result[0].text).toBe('2 items deleted by Someone, restorable from Trash for 30 days');
  expect(result[1]).toMatchObject({ text: '12 files added', actor: null, label: null });
});
test('account_level_screen_caps_at_10_folders_and_20_rows_per_folder', async () => {
  ports.listFolderLinks = async () => Array.from({ length: 25 }, (_, i) => ({ folder_id: `f${i % 12}`, created_at: new Date(2026, 9, i + 1).toISOString() }));
  const calls: any[] = [];
  ports.getSharedFolderActivity = async (id, limit) => { calls.push([id, limit]); return [row()]; };
  const groups = await loadAccountFolderActivity(ports);
  expect(groups).toHaveLength(10); expect(calls).toHaveLength(10); expect(calls.every(([, limit]) => limit === 20)).toBe(true);
  expect(groups[0].folderId).toBe('f0'); expect(new Set(groups.map(g => g.folderId)).size).toBe(10);
});
test('a_failed_folder_does_not_hide_the_others', async () => {
  ports.listFolderLinks = async () => [{ folder_id: 'bad', created_at: '2026-10-28' }, { folder_id: 'good', created_at: '2026-10-27' }];
  ports.getSharedFolderActivity = async id => { if (id === 'bad') throw new Error('offline'); return [row()]; };
  const groups = await loadAccountFolderActivity(ports);
  expect(groups[0]).toMatchObject({ folderId: 'bad', failed: true }); expect(groups[1].rows[0].text).toBe('12 files added via Family WhatsApp');
});
test('empty_response_is_an_empty_activity_list', async () => {
  ports.getSharedFolderActivity = async () => []; expect(await loadFolderActivity('f', 50, ports)).toEqual([]);
});
test('an_account_change_discards_decrypted_activity', async () => {
  const { advanceAccountEpoch } = await import('./account-epoch');
  ports.sharedFolderDecryptName = async () => { advanceAccountEpoch(); return 'Other account'; };
  await expect(loadFolderActivity('f', 50, ports)).rejects.toHaveProperty('name', 'StaleAccountError');
});

// Produced by web #198 c9be865 encryptActorName, using its vendored core WASM.
// Test-only independent AES oracle behind the MARKED native mock; this is
// envelope/seam evidence, not an iOS/Android native interoperability claim.
const webFixture = {"key":[17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17,17],"label":"{\"cipher_suite\":\"V1Aes256Gcm\",\"nonce\":[53,122,30,219,1,237,92,170,183,190,104,195],\"ciphertext\":[132,119,189,166,102,74,88,129,150,85,94,58,95,45,25,45,165,166,49,145,100,69,241,81,58,29,240,9,205,107,169]}","actor":"{\"cipher_suite\":\"V1Aes256Gcm\",\"nonce\":[61,8,35,137,7,220,223,120,246,19,192,193],\"ciphertext\":[240,165,178,209,28,142,212,80,180,125,42,101,241,78,120,97,199,97,225,29,199]}"};
test('web_made_label_and_actor_envelopes_decrypt', async () => {
  ports.getSharedFolderActivity = async () => [{ ...row(), share_label_encrypted: webFixture.label, actor_name_encrypted: webFixture.actor }];
  ports.sharedFolderDecryptName = async (_handle, envelope) => {
    const sealed = JSON.parse(envelope); expect(sealed.cipher_suite).toBe('V1Aes256Gcm');
    const bytes = Buffer.from(sealed.ciphertext);
    const decrypt = createDecipheriv('aes-256-gcm', Buffer.from(webFixture.key), Buffer.from(sealed.nonce));
    decrypt.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decrypt.update(bytes.subarray(0, -16)), decrypt.final()]).toString('utf8');
  };
  const [activity] = await loadFolderActivity('f', 50, ports);
  expect(activity).toMatchObject({ text: '12 files added via Family WhatsApp', label: 'Family WhatsApp', actor: 'Alice' });
});
