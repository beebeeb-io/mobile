// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
import { describe, expect, test } from 'bun:test';
import { NAME_UNAVAILABLE_FILE, NAME_UNAVAILABLE_FOLDER, rowNameDisplay } from './row-name';

const ENC = '{"cipher_suite":"V1Aes256Gcm","nonce":[1],"ciphertext":[2]}';

describe('rowNameDisplay (task 1592 item 6)', () => {
  test('decrypted → the name', () => {
    expect(rowNameDisplay({ decryptedName: 'Taxes', fallbackName: '', nameEncrypted: ENC, isFolder: true, nameUnavailable: false }))
      .toEqual({ kind: 'name', text: 'Taxes' });
  });

  test('still decrypting → the placeholder bar', () => {
    expect(rowNameDisplay({ decryptedName: undefined, fallbackName: '', nameEncrypted: ENC, isFolder: true, nameUnavailable: false }))
      .toEqual({ kind: 'pending' });
  });

  test('decrypt failed → settled words, never an endless placeholder', () => {
    expect(rowNameDisplay({ decryptedName: undefined, fallbackName: '', nameEncrypted: ENC, isFolder: true, nameUnavailable: true }))
      .toEqual({ kind: 'unavailable', text: NAME_UNAVAILABLE_FOLDER });
    expect(rowNameDisplay({ decryptedName: undefined, fallbackName: '', nameEncrypted: ENC, isFolder: false, nameUnavailable: true }))
      .toEqual({ kind: 'unavailable', text: NAME_UNAVAILABLE_FILE });
  });

  test('a plaintext (legacy) name needs no decrypt', () => {
    expect(rowNameDisplay({ decryptedName: undefined, fallbackName: 'old.txt', nameEncrypted: 'old.txt', isFolder: false, nameUnavailable: false }))
      .toEqual({ kind: 'name', text: 'old.txt' });
  });
});
