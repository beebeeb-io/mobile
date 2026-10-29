/**
 * Task 2233 item 1 (A5) — access to the modern `expo-file-system` `File`
 * API, isolated behind one tiny adapter so:
 *
 *  - a thumbnail write can pass the decrypted `Uint8Array` straight to
 *    native (no base64 string, no native base64 decode);
 *  - the legacy string writer stays as a fallback when the modern module is
 *    unavailable (older runtime, or a test that does not mock it);
 *  - tests can mock this adapter and count byte writes / directory creates.
 *
 * The module is loaded lazily: importing it must never pull the native
 * `expo-file-system` module into a unit-test process.
 */
export interface ModernThumbnailFs {
  /** Create the directory (idempotent) — called once per session, not per tile. */
  ensureDir(uri: string): Promise<void>;
  /** Write bytes to `uri`, overwriting. */
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
}

let cached: ModernThumbnailFs | null | undefined;

function load(): ModernThumbnailFs | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as {
      File?: new (uri: string) => { write: (content: string | Uint8Array) => void };
      Directory?: new (uri: string) => {
        create: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
      };
    };
    const FileCtor = mod?.File;
    const DirectoryCtor = mod?.Directory;
    if (typeof FileCtor !== 'function' || typeof DirectoryCtor !== 'function') {
      cached = null;
      return null;
    }
    cached = {
      async ensureDir(uri: string): Promise<void> {
        new DirectoryCtor(uri).create({ intermediates: true, idempotent: true });
      },
      async writeBytes(uri: string, bytes: Uint8Array): Promise<void> {
        new FileCtor(uri).write(bytes);
      },
    };
  } catch {
    cached = null;
  }
  return cached;
}

export function getModernThumbnailFs(): ModernThumbnailFs | null {
  return load();
}

/** Test-only: forget the cached module probe. */
export function resetModernThumbnailFsForTests(): void {
  cached = undefined;
}
