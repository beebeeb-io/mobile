// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { afterEach, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let flag = { enabled: false, loading: false };
let calls = 0;
mock.module('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'Input', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner', Share: {}, Platform: { OS: 'ios' }, StyleSheet: { create: x => x } }));
mock.module('@react-navigation/native', () => ({ useNavigation: () => ({ goBack() {} }), useRoute: () => ({ params: { fileId: 'f', fileName: 'Photos', isFolder: true } }) }));
mock.module('expo-clipboard', () => ({})); mock.module('expo-haptics', () => ({}));
mock.module('../lib/theme-context', () => ({ useTheme: () => ({ colors: {}, resolved: 'light' }) }));
mock.module('../lib/toast-context', () => ({ useToast: () => ({ showToast() {} }) }));
mock.module('../lib/useKeyboardLayoutAnimation', () => ({ useKeyboardLayoutAnimation() {} }));
mock.module('../lib/crypto-context', () => ({ useCrypto: () => ({ isUnlocked: false }) }));
mock.module('../lib/use-shared-folders-flag', () => ({ useSharedFoldersFlag: () => flag }));
mock.module('../lib/api', () => ({ ApiError: class extends Error {}, approveInvite() {}, createBundleShare() {}, createInvite() {}, createShare() {}, friendlyError() {}, getWebAppUrl() {}, listAllFiles: async () => [], resolveSharingContact() {}, listFolderLinks: () => calls++, getFolderMembers: () => calls++, getSharedFolder: () => calls++ }));
mock.module('../../modules/beebeeb-crypto', () => ({ deriveShareKey() {}, encryptChunk() {}, generateRandomBytes() {}, wrapForOwnerWithHandle() {}, x25519SharedSecret() {} }));
mock.module('../components/sheet/BottomSheet', () => ({ BottomSheet: 'Sheet', BottomSheetScrollView: 'ScrollView' }));
mock.module('../components/folder-share/FolderSharePanel', () => ({ FolderSharePanel: () => { calls += 3; return React.createElement('Panel'); } }));
const { default: ShareSheetScreen } = await import('./ShareSheetScreen');
let renderer: any;
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); });
test('flag_off_makes_no_request_and_keeps_the_bundle_block', async () => {
  calls = 0; flag = { enabled: false, loading: false };
  await act(async () => { renderer = TestRenderer.create(React.createElement(ShareSheetScreen)); });
  expect(calls).toBe(0); expect(renderer.root.findAllByType('Panel')).toHaveLength(0);
  const source = readFileSync('src/screens/ShareSheetScreen.tsx', 'utf8');
  expect(source.slice(source.indexOf('      // ── Folder snapshot bundle (task 2238)'), source.indexOf('      let wrappedFileKey:'))).toBe(readFileSync('src/screens/__fixtures__/share-sheet-bundle-block.txt', 'utf8'));
});
test('flag_on_uses_the_folder_panel_in_the_existing_bottom_sheet', async () => {
  calls = 0; flag = { enabled: true, loading: false };
  await act(async () => { renderer = TestRenderer.create(React.createElement(ShareSheetScreen)); });
  expect(renderer.root.findAllByType('Panel')).toHaveLength(1); expect(renderer.root.findAllByType('Sheet')).toHaveLength(1); expect(calls).toBe(3);
});
test('checking_sharing_options_precedes_any_new_endpoint', async () => {
  calls = 0; flag = { enabled: false, loading: true };
  await act(async () => { renderer = TestRenderer.create(React.createElement(ShareSheetScreen)); });
  expect(renderer.root.findAllByType('Text').map(n => n.children.filter(c => typeof c === 'string').join('')).join(' ')).toContain('Checking sharing options...'); expect(calls).toBe(0);
});
