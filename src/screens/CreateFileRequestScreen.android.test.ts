// @ts-nocheck — isolated Bun; drive the real handler against Android's registered surface.
import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
const screen = readFileSync(new URL('./CreateFileRequestScreen.tsx', import.meta.url), 'utf8');
const android = readFileSync(new URL('../../modules/beebeeb-crypto/android/src/main/java/expo/modules/beebeebcrypto/BeebeebCryptoModule.kt', import.meta.url), 'utf8');
const handler = new Bun.Transpiler({ loader: 'ts' }).transformSync(screen.slice(screen.indexOf('const handleCreate ='), screen.indexOf('\n  return (', screen.indexOf('const handleCreate ='))));
let events, error, creating, failCrypto;
beforeEach(() => { events = []; error = null; creating = false; failCrypto = false; });
function create({ title = 'Send photos', isUnlocked = true } = {}) {
  // Native bridge omits unregistered methods, reproducing the device TypeError.
  const native = {};
  if (android.includes('AsyncFunction("createRequestKeypairWithHandle")')) {
    native.createRequestKeypairWithHandle = async () => {
      if (failCrypto) throw new Error('vault locked');
      events.push('keypair');
      return { publicKey: new Uint8Array([255]), wrapped: new Uint8Array([1]), nonce: new Uint8Array([2]) };
    };
  }
  return new Function('useCallback', 'Platform', 'title', 'description', 'targetFolderId', 'maxFiles', 'maxBytes', 'expirySecs', 'isUnlocked', 'createRequestKeypair', 'createFileRequest', 'toBase64', 'toBase64url', 'Share', 'navigation', 'setError', 'setCreating', `${handler}; return handleCreate;`)(
    fn => fn, { OS: 'android' }, title, '', null, '1', null, null, isUnlocked,
    () => native.createRequestKeypairWithHandle(7), async params => { events.push(['post', params]); return { request_url: 'https://example.test/r/token' }; },
    bytes => Buffer.from(bytes).toString('base64'), bytes => Buffer.from(bytes).toString('base64url'),
    { share: async payload => { events.push(['share', payload]); } }, { goBack: () => events.push('back') },
    value => { error = value; }, value => { creating = value; },
  );
}
test('Android create-and-share uses its native request keypair and shares a self-contained link', async () => {
  await create()();
  expect(error).toBeNull();
  expect(events).toEqual(['keypair', ['post', { title: 'Send photos', description: undefined, target_folder_id: undefined, max_files: 1, max_total_bytes: undefined, expires_in_secs: undefined, wrapped_private_key: 'AQ==', wrap_nonce: 'Ag==' }], ['share', { message: 'https://example.test/r/token#_w', title: 'Send photos' }], 'back']);
  expect(creating).toBe(false);
});
test('keypair failure never posts or shares', async () => {
  failCrypto = true;
  await create()();
  expect(error).toBe('vault locked');
  expect(events).toEqual([]);
  expect(creating).toBe(false);
});
test('locked vault and empty title never start crypto', async () => {
  await create({ isUnlocked: false })();
  expect(error).toContain('locked');
  await create({ title: ' ' })();
  expect(error).toContain('title');
  expect(events).toEqual([]);
});
