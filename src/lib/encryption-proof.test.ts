// @ts-nocheck
// Task 1591 bug 2 — "Prove it": the "What you see" pane showed the CIPHERTEXT
// (read as text) and the footer printed the API download URL. Mutation
// evidence: task 1591 Notes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROOF_BYTES, bytesToHex, bytesToReadable, proofSeePane } from './encryption-proof';

const enc = (s: string) => new TextEncoder().encode(s);

describe('proofSeePane', () => {
  test('ready: shows the DECRYPTED bytes, read as text', () => {
    const plaintext = enc('%PDF-1.7\n%âã\n1 0 obj');
    const pane = proofSeePane({ status: 'ready', plaintext });
    expect(pane.body).toContain('%PDF-1.7');
    expect(pane.body).toBe(bytesToReadable(plaintext));
    expect(pane.note).toMatch(/after decryption on this device/);
  });

  test('ready: never more than PROOF_BYTES', () => {
    const plaintext = new Uint8Array(PROOF_BYTES * 3).fill(0x41);
    expect(proofSeePane({ status: 'ready', plaintext }).body.length).toBe(PROOF_BYTES);
  });

  test('loading / too-large / failed: no body — nothing else stands in for the plaintext', () => {
    expect(proofSeePane({ status: 'loading' }).body).toBeNull();
    expect(proofSeePane({ status: 'too-large' }).body).toBeNull();
    expect(proofSeePane({ status: 'too-large' }).note).toMatch(/too large to decrypt/);
    expect(proofSeePane({ status: 'failed' }).body).toBeNull();
    expect(proofSeePane({ status: 'failed' }).note).toMatch(/Could not decrypt/);
  });

  test('hex dump formatting is unchanged', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('00 0f ff');
  });
});

describe('EncryptionProof component wiring', () => {
  const source = readFileSync(join(import.meta.dir, '../components/EncryptionProof.tsx'), 'utf-8');

  test('the "What you see" block renders seePane.body, never the ciphertext bytes', () => {
    expect(source).toContain('proofSeePane(plain)');
    expect(source).toContain('{seePane.body}');
    // the ciphertext is only ever hex-dumped
    expect(source).not.toMatch(/bytesToReadable\(\s*bytes/);
  });

  test('the left pane is fed by an on-device decrypt', () => {
    // Task 1593: the session (src/lib/proof-session.ts) owns the flow; the
    // component hands it decryptToTempFile and the plaintext pane setter.
    expect(source).toMatch(/decryptToTempFile\(/);
    expect(source).toMatch(/startProofSession\(/);
    expect(source).toMatch(/onPlain: setPlain,/);
  });

  test('no infrastructure URL is shown to the user', () => {
    // Task 1593: the download URL is used for the 512-byte ranged request
    // (the fetch argument) and nowhere else — never rendered.
    expect(source.match(/getDownloadUrl\(/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/fetchCiphertextPrefix\(getDownloadUrl\(file\.id\),/);
    expect(source).not.toContain('getApiUrl');
    expect(source).not.toMatch(/localhost|https?:\/\//);
  });
});
