// @ts-nocheck
// Task 1591 bug 5 — Encryption details copy. "Key source: Derived from file
// ID" read as weak crypto and misdescribed core's derivation
// (beebeeb-core/src/kdf.rs derive_file_key: HKDF-SHA256 over the MASTER KEY,
// info = "beebeeb-file-key-v1" || file_id); "Encrypted by: <this device's
// name>" was false for files another client uploaded. Mutation evidence:
// task 1591 Notes.
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// file-request-crypto imports the native crypto module; this file mocks it
// itself (mobile/CLAUDE.md "Tests" — per-file isolation).
mock.module('../../modules/beebeeb-crypto', () => ({
  openRequestUpload: async () => new Uint8Array(),
  unwrapRequestPrivateWithHandle: async () => new Uint8Array(),
}));
mock.module('./api', () => ({ listFileRequests: async () => [] }));

const { TRUST_ENCRYPTED_ON_LABEL, trustEncryptedOnValue, trustKeySourceLabel } = await import('./trust-details');

const normal = { file_request_id: null, sender_ephemeral_pubkey: null, wrapped_content_key: null };
const request = { file_request_id: 'r1', sender_ephemeral_pubkey: 'AAAA', wrapped_content_key: 'BBBB' };

describe('Key source', () => {
  test('a normal file: per-file key derived from the master key with HKDF-SHA256', () => {
    const s = trustKeySourceLabel(normal);
    expect(s).toBe('Per-file key, derived from your master key (HKDF-SHA256)');
    expect(s).not.toMatch(/file ID/i);
  });
  test('a file-request upload: random key sealed to the request key', () => {
    expect(trustKeySourceLabel(request)).toBe('Random per-file key, sealed to your file request key');
  });
});

describe('Encrypted on', () => {
  test('states where encryption happened, never a device name', () => {
    expect(TRUST_ENCRYPTED_ON_LABEL).toBe('Encrypted on');
    expect(trustEncryptedOnValue(normal)).toBe('Your device, before upload');
    expect(trustEncryptedOnValue(request)).toBe("The sender's device, before upload");
  });

  test('TrustDetailsSheet no longer reads this device\'s name and uses the pinned copy', () => {
    const src = readFileSync(join(import.meta.dir, '../components/TrustDetailsSheet.tsx'), 'utf-8');
    expect(src).not.toContain('expo-device');
    expect(src).not.toContain('deviceName');
    expect(src).not.toContain('Derived from file ID');
    expect(src).not.toContain('"Encrypted by"');
    expect(src).toContain('trustKeySourceLabel(file)');
    expect(src).toContain('trustEncryptedOnValue(file)');
  });
});
