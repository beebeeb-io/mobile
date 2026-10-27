/**
 * zip-file-source — the on-disk ByteSource for `zip-reader` (task 2233 item 6).
 *
 * Uses expo-file-system's `File`/`FileHandle` (SDK 57) so a read is a bounded
 * `pread` at an offset: the archive is never slurped into JS. Kept separate
 * from the pure reader so bun can test the parsing against an in-memory source.
 */
import { File, FileMode } from 'expo-file-system';
import type { ByteSource } from './zip-reader';

export interface ZipFileSource extends ByteSource {
  readonly uri: string;
  close(): void;
}

/** Opens `uri` read-only. The caller must `close()` it (PreviewScreen does on unmount). */
export function openZipFileSource(uri: string): ZipFileSource {
  const file = new File(uri);
  const size = file.size ?? 0;
  const handle = file.open(FileMode.ReadOnly);
  let closed = false;
  return {
    uri,
    size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      if (closed) throw new Error('The archive was closed.');
      handle.offset = offset;
      return handle.readBytes(length);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        handle.close();
      } catch {
        // already closed by the OS
      }
    },
  };
}
