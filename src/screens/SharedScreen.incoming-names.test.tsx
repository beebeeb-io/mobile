// @ts-nocheck — bun:test is outside the Expo tsconfig.
// Task 2263 — the Shared tab rendered every incoming share as "Encrypted file":
// the invite's `file_name_encrypted` was never decrypted. This mounts the real
// screen with the native crypto module mocked by WebCrypto AES-GCM (the same
// primitive core uses) and the REAL wire shapes (60-byte wrapped file key,
// `{cipher_suite,nonce,ciphertext}` name envelope), so a passing test proves the
// screen derives the file key from the sender's public key and shows the name.
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const subtle = globalThis.crypto.subtle;

async function aesGcmEncrypt(key, plaintext) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  return { nonce, ct: new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plaintext)) };
}
async function aesGcmDecrypt(key, nonce, ct) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
}
function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const FILE_ID = '9d1c0a1e-0000-4000-8000-000000000263';
const SHARE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const FILE_KEY = Uint8Array.from({ length: 32 }, (_, i) => 100 + i);

let inviteRows = [];
let focusEffects = [];
// The decrypt effect's progress, so a test can wait for it instead of guessing
// how many microtask ticks WebCrypto needs (under the full-suite load it needs
// real macrotask turns).
let nameAttempts = 0;
let nameInFlight = 0;

function invite(fields) {
  return {
    id: 'invite-1', file_id: FILE_ID, sender_id: 'sender', sender_email: 'sender@example.com',
    recipient_email: 'me@example.com', status: 'approved', created_at: new Date().toISOString(),
    ...fields,
  };
}

async function wrappedFileKey(shareKey, fileKey) {
  const { nonce, ct } = await aesGcmEncrypt(shareKey, fileKey);
  const blob = new Uint8Array(nonce.length + ct.length);
  blob.set(nonce, 0); blob.set(ct, nonce.length);
  return b64(blob);
}
async function nameEnvelope(key, name) {
  const { nonce, ct } = await aesGcmEncrypt(key, new TextEncoder().encode(JSON.stringify({ name })));
  return JSON.stringify({ cipher_suite: 'V1Aes256Gcm', nonce: Array.from(nonce), ciphertext: Array.from(ct) });
}

mock.module('react-native', () => {
  const FlatList = ({ data, renderItem, ListEmptyComponent }) => {
    const items = (data ?? []).map((item, index) => renderItem({ item, index }));
    if (items.length) return React.createElement(React.Fragment, null, ...items);
    return typeof ListEmptyComponent === 'function' ? React.createElement(ListEmptyComponent) : null;
  };
  return {
    View: 'View', Text: 'Text', TouchableOpacity: 'Button', ActivityIndicator: 'Spinner',
    ScrollView: 'ScrollView', FlatList, RefreshControl: 'Refresh', StyleSheet: { create: (x) => x },
  };
});
mock.module('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
mock.module('expo-haptics', () => ({ impactAsync: async () => {}, selectionAsync: async () => {}, notificationAsync: async () => {}, ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' }, NotificationFeedbackType: { Success: 'success', Error: 'error' } }));
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }));
mock.module('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate() {}, goBack() {} }),
  useFocusEffect: (cb) => { focusEffects.push(cb); },
}));
mock.module('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
mock.module('../lib/theme-context', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#000' }) }),
}));
mock.module('../lib/use-shared-folders-flag', () => ({ useSharedFoldersFlag: () => ({ enabled: false, loading: false }) }));
mock.module('../components/glass', () => ({ GlassSegment: 'Segment', ScrollEdgeBlur: 'Blur', SCROLL_EDGE: { chromeFallback: 64 }, useTabBarBottomInset: () => 0 }));
mock.module('../components/SkeletonRow', () => ({ default: 'Skeleton' }));
mock.module('./FileRequestsScreen', () => ({ default: 'Requests' }));
mock.module('../lib/toast-context', () => ({ useToast: () => ({ showToast() {} }) }));
// The real context derives these with useCallback, so their identity is stable
// across renders; an unstable mock would make any effect that lists them loop.
const getMasterKeyHandleId = () => 7;
const decryptMetadata = async () => '';
mock.module('../lib/crypto-context', () => ({ useCrypto: () => ({ isUnlocked: true, decryptMetadata, getMasterKeyHandleId }) }));
mock.module('../lib/api', () => ({
  getIncomingInvites: async () => inviteRows,
  getSentInvites: async () => [],
  listMyShares: async () => [],
  friendlyError: () => 'Try again.',
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  unwrapForOwnerWithHandle: async () => new Uint8Array(32),
  handleDeriveX25519Private: async () => Uint8Array.from({ length: 32 }, (_, i) => 7 + i),
  x25519SharedSecret: async () => Uint8Array.from({ length: 32 }, (_, i) => 3),
  deriveShareKey: async () => SHARE_KEY.slice(),
  decryptChunk: aesGcmDecrypt,
  // Stand-in for core's `FileKeyHandle::decryptNameMetadata` (raw-key envelope here).
  decryptNameWithKey: async (fileKey, envelope) => {
    nameAttempts += 1;
    nameInFlight += 1;
    try {
    const parsed = JSON.parse(envelope);
    const pt = await aesGcmDecrypt(fileKey, Uint8Array.from(parsed.nonce), Uint8Array.from(parsed.ciphertext));
    const meta = JSON.parse(new TextDecoder().decode(pt));
    return { name: typeof meta.name === 'string' ? meta.name : null, mimeType: meta.mime_type ?? null };
    } finally {
      nameInFlight -= 1;
    }
  },
}));

const { default: SharedScreen } = await import('./SharedScreen');

let renderer;
beforeEach(() => { inviteRows = []; focusEffects = []; nameAttempts = 0; nameInFlight = 0; });
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); renderer = null; });

async function mount() {
  await act(async () => { renderer = TestRenderer.create(React.createElement(SharedScreen)); });
  // Let the focus fetch and the follow-up name decrypt settle.
  await act(async () => { for (const cb of focusEffects) cb(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

/** Let the fetch, then the decrypt effect, actually finish on this machine. */
async function settleUntil(done, tries = 250) {
  for (let i = 0; i < tries && !done(); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  }
}

const allText = () => renderer.root.findAllByType('Text')
  .map((n) => n.children.filter((c) => typeof c === 'string').join('')).join(' | ');

test('an incoming share shows its decrypted name (task 2263)', async () => {
  inviteRows = [invite({
    file_name_encrypted: await nameEnvelope(FILE_KEY, 'Q3 report.pdf'),
    sender_public_key: b64(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)),
    encrypted_file_key: await wrappedFileKey(SHARE_KEY, FILE_KEY),
  })];
  await mount();
  await settleUntil(() => nameAttempts > 0 && nameInFlight === 0);
  expect(allText()).toContain('Q3 report.pdf');
  expect(allText()).not.toContain('Encrypted file');
});

test('a tampered name shows the honest failure state (task 2263)', async () => {
  inviteRows = [invite({
    file_name_encrypted: await nameEnvelope(Uint8Array.from({ length: 32 }, (_, i) => 55 + i), 'Q3 report.pdf'),
    sender_public_key: b64(Uint8Array.from({ length: 32 }, (_, i) => 7 + i)),
    encrypted_file_key: await wrappedFileKey(SHARE_KEY, FILE_KEY),
  })];
  await mount();
  await settleUntil(() => nameAttempts > 0 && nameInFlight === 0);
  expect(nameAttempts).toBeGreaterThan(0); // the decrypt WAS attempted
  expect(allText()).toContain("Can't show this name");
  expect(allText()).not.toContain('Encrypted file');
});

test('a legacy plaintext invite name is shown as-is (task 2263)', async () => {
  inviteRows = [invite({ file_name_encrypted: 'old report.pdf' })];
  await mount();
  await settleUntil(() => allText().includes('old report.pdf'));
  expect(allText()).toContain('old report.pdf');
});
