/**
 * "Prove it" display logic (task 1591, bug 2).
 *
 * The screen compares two views of the SAME first bytes of a file:
 *   - "What you see"            — the DECRYPTED bytes (your file as it is on
 *                                 your device), shown as text so a format's
 *                                 readable structure (JFIF, %PDF, PK, plain
 *                                 prose) shows through;
 *   - "What our server stores"  — the ciphertext bytes as a hex dump.
 *
 * Before 1591 the component never decrypted anything: both panes rendered
 * the ciphertext (one as text, one as hex), so "What you see" showed noise
 * and the comparison proved nothing. `proofSeePane` below is the single
 * decision point for what the left pane shows; it can never be handed the
 * ciphertext.
 */

export const PROOF_BYTES = 512;

/**
 * Above this plaintext size the proof does not decrypt the file just to show
 * its first bytes (the native decrypt path works on whole files). The pane
 * then says so instead of pretending.
 */
export const PROOF_DECRYPT_MAX_BYTES = 64 * 1024 * 1024;

export function bytesToHex(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return out.join(' ');
}

export function bytesToReadable(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // Printable ASCII + common whitespace; everything else collapses to '.'
    if ((b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x09) {
      out.push(String.fromCharCode(b));
    } else {
      out.push('.');
    }
  }
  return out.join('');
}

export type PlaintextPrefixState =
  | { status: 'loading' }
  | { status: 'ready'; plaintext: Uint8Array }
  | { status: 'too-large' }
  | { status: 'failed' };

export interface ProofSeePane {
  /** Short explanation under the pane label. */
  note: string;
  /** The mono block's content, or null when there is nothing to show. */
  body: string | null;
}

/**
 * What the "What you see" pane shows. Takes ONLY the decrypted-prefix state —
 * the ciphertext is deliberately not a parameter, so it cannot leak into the
 * plaintext pane again.
 */
export function proofSeePane(state: PlaintextPrefixState): ProofSeePane {
  switch (state.status) {
    case 'ready':
      return {
        note: 'The first bytes of your file after decryption on this device, read as text. Its structure is readable.',
        body: bytesToReadable(state.plaintext.slice(0, PROOF_BYTES)),
      };
    case 'loading':
      return { note: 'Decrypting on this device…', body: null };
    case 'too-large':
      return {
        note: 'This file is too large to decrypt just for this comparison. Open it to see it decrypted on this device.',
        body: null,
      };
    case 'failed':
    default:
      return {
        note: 'Could not decrypt this file on this device, so there is nothing to compare against.',
        body: null,
      };
  }
}
