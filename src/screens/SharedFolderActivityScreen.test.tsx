// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let flag = { enabled: true, loading: false };
let params: any = { folderId: 'folder' };
let groups: any[];
let rows: any[];
let calls: any[];
mock.module('react-native', () => ({ View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner', ScrollView: 'ScrollView', FlatList: 'List', RefreshControl: 'Refresh', StyleSheet: { create: x => x } }));
mock.module('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
mock.module('expo-haptics', () => ({})); mock.module('expo-clipboard', () => ({}));
mock.module('@react-navigation/native', () => ({ useRoute: () => ({ params }), useNavigation: () => ({ navigate() {}, goBack() {} }), useFocusEffect() {} }));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('../lib/theme-context', () => ({ useTheme: () => ({ colors: { paper: '#fff', ink: '#111', ink2: '#333', ink3: '#555', line: '#ddd' } }) }));
mock.module('../lib/use-shared-folders-flag', () => ({ useSharedFoldersFlag: () => flag }));
mock.module('../lib/folder-activity', () => ({ loadFolderActivity: async (id, limit) => { calls.push([id, limit]); return rows; }, loadAccountFolderActivity: async () => { calls.push('account'); return groups; } }));
mock.module('../components/glass', () => ({ GlassSegment: 'Segment', ScrollEdgeBlur: 'Blur', SCROLL_EDGE: {}, useTabBarBottomInset: () => 0 }));
mock.module('../components/SkeletonRow', () => ({ default: 'Skeleton' }));
mock.module('./FileRequestsScreen', () => ({ default: 'Requests' }));
mock.module('../lib/toast-context', () => ({ useToast: () => ({ showToast() {} }) }));
mock.module('../lib/crypto-context', () => ({ useCrypto: () => ({ isUnlocked: false }) }));
mock.module('../../modules/beebeeb-crypto', () => ({ unwrapForOwnerWithHandle() {}, decryptChunk: async () => new Uint8Array(32), decryptNameWithKey: async () => ({ name: null, mimeType: null }), deriveShareKey: async () => new Uint8Array(32), handleDeriveX25519Private: async () => new Uint8Array(32), x25519SharedSecret: async () => new Uint8Array(32) }));
mock.module('../lib/api', () => ({ getIncomingInvites: async () => [], getSentInvites: async () => [], listMyShares: async () => [], friendlyError: () => 'Try again.' }));
const { default: Screen } = await import('./SharedFolderActivityScreen');
const { default: SharedScreen } = await import('./SharedScreen');
let renderer: any;
beforeEach(() => { flag = { enabled: true, loading: false }; params = { folderId: 'folder' }; rows = []; groups = []; calls = []; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });
async function mount(component = Screen) { await act(async () => { renderer = TestRenderer.create(React.createElement(component)); }); }
const text = () => renderer.root.findAllByType('Text').map(n => n.children.filter(c => typeof c === 'string').join('')).join(' ');
test('empty_response_reads_No_activity_yet', async () => { await mount(); expect(text()).toContain('No activity yet.'); expect(calls).toEqual([['folder', 50]]); });
test('folder_activity_displays_the_decrypted_copy', async () => { rows = [{ id: 'a', text: '12 files added via Family WhatsApp', last_at: '2026-10-28' }]; await mount(); expect(text()).toContain('12 files added via Family WhatsApp'); });
test('account_level_screen_uses_the_bounded_account_loader', async () => {
  params = undefined; groups = Array.from({ length: 10 }, (_, i) => ({ folderId: `f${i}`, failed: false, rows: [{ id: `r${i}`, text: `${i} files added`, last_at: '2026-10-28' }] }));
  await mount(); expect(calls).toEqual(['account']); expect(renderer.root.findAll(n => typeof n.props.testID === 'string' && n.props.testID.startsWith('folder-activity-group-'))).toHaveLength(10);
});
test('a_failed_folder_still_displays_the_successful_folder', async () => {
  params = undefined; groups = [{ folderId: 'bad', failed: true, rows: [] }, { folderId: 'good', failed: false, rows: [{ id: 'a', text: '12 files added via Family', last_at: '2026-10-28' }] }];
  await mount(); expect(text()).toContain("Couldn't load activity for this folder."); expect(text()).toContain('12 files added via Family');
});
test('flag_off_hides_the_entry_row', async () => {
  flag = { enabled: false, loading: false }; await mount(SharedScreen);
  expect(renderer.root.findAllByProps({ testID: 'shared-folder-activity-entry' })).toHaveLength(0);
});
test('flag_on_shows_the_entry_row', async () => { await mount(SharedScreen); expect(renderer.root.findAllByProps({ testID: 'shared-folder-activity-entry' })).toHaveLength(1); });
test('flag_off_activity_screen_makes_no_activity_requests', async () => {
  flag = { enabled: false, loading: false }; await mount(); expect(calls).toEqual([]); expect(text()).toContain('Folder activity is not available.');
});
