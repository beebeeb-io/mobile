/**
 * zip-reader — bounded, ranged reading of a .zip archive (task 2233 item 6).
 *
 * The failure this replaces: PreviewScreen read the WHOLE decrypted archive into
 * a JS ArrayBuffer and handed it to JSZip, so a 50 MB+ zip exhausted the JS heap
 * (or the bridge's base64 copies) on both platforms. Reading only the tail (the
 * end-of-central-directory), then the central directory, then one entry on
 * demand keeps memory bounded regardless of the archive's size.
 *
 * Pure module: no react-native, no expo imports, so bun can test it with an
 * in-memory ByteSource. `zip-file-source.ts` supplies the on-disk source.
 */

/** Central directory is read in ONE ranged read; above this we refuse. */
export const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
/** Entries above this are refused (the listing would not be navigable anyway). */
export const MAX_ENTRIES = 50_000;
/** One entry may inflate to at most this much for in-app preview/share. */
export const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
/** EOCD (22) + the longest possible archive comment. */
const EOCD_SEARCH_BYTES = 22 + 0xffff;
/** Deflate output is inflated in bounded slices from the source. */
const READ_CHUNK_BYTES = 256 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

export type ZipReadErrorCode =
  | 'too-large'
  | 'corrupt'
  | 'multi-disk'
  | 'encrypted'
  | 'unsupported-method';

/** Every refusal carries a machine code so the UI can pick copy + fallback. */
export class ZipReadError extends Error {
  constructor(readonly code: ZipReadErrorCode, message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

/** Random access over a byte range. Implementations must not read more than asked. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntryMeta {
  /** Decoded path exactly as stored (unsafe names are kept for DISPLAY only). */
  path: string;
  /** Basename. */
  name: string;
  isFolder: boolean;
  uncompressedSize: number;
  compressedSize: number;
  method: number;
  flags: number;
  crc32: number;
  localHeaderOffset: number;
  modifiedAt: Date | null;
  /** True when general-purpose bit 11 was set (names are UTF-8). */
  utf8: boolean;
  /**
   * True for names containing a `..` segment or starting with `/`. They may be
   * shown, but must never be used as a filesystem path.
   */
  unsafeName: boolean;
}

export interface ZipListing {
  entries: ZipEntryMeta[];
  totalUncompressed: number;
  /** True when the archive needed a ZIP64 end-of-central-directory. */
  entryCount64: boolean;
  archiveSize: number;
}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/** 64-bit field → number; refuses values a JS number cannot represent. */
function u64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipReadError('too-large', 'This archive is too large to read here.');
  }
  return Number(value);
}

function assertRange(offset: number, length: number, size: number, what: string): void {
  if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new ZipReadError('corrupt', `The archive is damaged (${what} is outside the file).`);
  }
}

/** CP437 high half (0x80–0xFF), the historical default for un-flagged names. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

/**
 * Decode a raw name. Bit 11 of the flags means UTF-8; otherwise the ZIP spec's
 * default code page is CP437 (never UTF-8 — that is what made accents garble).
 */
export function decodeZipName(raw: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder('utf-8').decode(raw);
  let out = '';
  for (const byte of raw) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else out += CP437_HIGH[byte - 0x80] ?? '�';
  }
  return out;
}

function unsafeZipName(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  return path.split(/[/\\]/).some((segment) => segment === '..');
}

function dosDateToDate(date: number, time: number): Date | null {
  if (date === 0) return null;
  const year = 1980 + ((date >> 9) & 0x7f);
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  if (month < 0 || day === 0) return null;
  return new Date(year, month, day, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

interface EndOfCentralDirectory {
  totalEntries: number;
  cdOffset: number;
  cdSize: number;
  zip64: boolean;
}

/** Finds and parses the EOCD (and the ZIP64 record when it is the real one). */
async function readEndOfCentralDirectory(source: ByteSource): Promise<EndOfCentralDirectory> {
  if (source.size < 22) throw new ZipReadError('corrupt', 'This is not a readable ZIP archive.');
  const tailLength = Math.min(source.size, EOCD_SEARCH_BYTES);
  const tailStart = source.size - tailLength;
  const tail = await source.read(tailStart, tailLength);
  if (tail.length !== tailLength) throw new ZipReadError('corrupt', 'The archive could not be read completely.');

  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocdAt = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(view, i) !== SIG_EOCD) continue;
    const commentLength = u16(view, i + 20);
    if (i + 22 + commentLength !== tail.length) continue;
    eocdAt = i;
    break;
  }
  if (eocdAt === -1) throw new ZipReadError('corrupt', 'This is not a readable ZIP archive.');

  const diskNumber = u16(view, eocdAt + 4);
  const cdStartDisk = u16(view, eocdAt + 6);
  if (diskNumber !== 0 || cdStartDisk !== 0) {
    throw new ZipReadError('multi-disk', 'Multi-volume archives cannot be opened here.');
  }

  let totalEntries = u16(view, eocdAt + 10);
  let cdSize = u32(view, eocdAt + 12);
  let cdOffset = u32(view, eocdAt + 16);

  const needsZip64 = totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (!needsZip64) {
    return { totalEntries, cdOffset, cdSize, zip64: false };
  }

  const eocdAbsolute = tailStart + eocdAt;
  assertRange(eocdAbsolute - 20, 20, source.size, 'ZIP64 locator');
  const locator = await source.read(eocdAbsolute - 20, 20);
  const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
  if (u32(locatorView, 0) !== SIG_ZIP64_LOCATOR) {
    throw new ZipReadError('corrupt', 'The archive is damaged (missing ZIP64 locator).');
  }
  if (u32(locatorView, 4) !== 0) {
    throw new ZipReadError('multi-disk', 'Multi-volume archives cannot be opened here.');
  }
  const zip64EocdOffset = u64(locatorView, 8);
  assertRange(zip64EocdOffset, 56, source.size, 'ZIP64 record');
  const record = await source.read(zip64EocdOffset, 56);
  const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
  if (u32(recordView, 0) !== SIG_ZIP64_EOCD) {
    throw new ZipReadError('corrupt', 'The archive is damaged (bad ZIP64 record).');
  }
  const zip64Disk = u32(recordView, 16);
  const zip64CdStartDisk = u32(recordView, 20);
  if (zip64Disk !== 0 || zip64CdStartDisk !== 0) {
    throw new ZipReadError('multi-disk', 'Multi-volume archives cannot be opened here.');
  }
  totalEntries = u64(recordView, 32);
  cdSize = u64(recordView, 40);
  cdOffset = u64(recordView, 48);
  return { totalEntries, cdOffset, cdSize, zip64: true };
}

interface CentralEntryRaw {
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  nameBytes: Uint8Array;
  modifiedAt: Date | null;
}

/** Parses one central-directory record starting at `offset`; returns its length. */
function parseCentralEntry(cd: Uint8Array, offset: number): { entry: CentralEntryRaw; length: number } {
  const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  if (u32(view, offset) !== SIG_CENTRAL) {
    throw new ZipReadError('corrupt', 'The archive is damaged (bad central directory entry).');
  }
  const flags = u16(view, offset + 8);
  const method = u16(view, offset + 10);
  const time = u16(view, offset + 12);
  const date = u16(view, offset + 14);
  const crc32 = u32(view, offset + 16);
  let compressedSize = u32(view, offset + 20);
  let uncompressedSize = u32(view, offset + 24);
  const nameLength = u16(view, offset + 28);
  const extraLength = u16(view, offset + 30);
  const commentLength = u16(view, offset + 32);
  const diskStart = u16(view, offset + 34);
  let localHeaderOffset = u32(view, offset + 42);
  const length = 46 + nameLength + extraLength + commentLength;
  if (offset + length > cd.length) {
    throw new ZipReadError('corrupt', 'The archive is damaged (truncated central directory).');
  }
  if (diskStart !== 0 && diskStart !== 0xffff) {
    throw new ZipReadError('multi-disk', 'Multi-volume archives cannot be opened here.');
  }
  const nameBytes = cd.slice(offset + 46, offset + 46 + nameLength);

  // ZIP64 extended information (0x0001): present fields appear in the fixed
  // order uncompressed, compressed, local offset, disk start — only for the
  // values that overflowed to 0xffffffff in the fixed header.
  if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
    let extraAt = offset + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    let found = false;
    while (extraAt + 4 <= extraEnd) {
      const id = u16(view, extraAt);
      const size = u16(view, extraAt + 2);
      if (id === 0x0001) {
        let field = extraAt + 4;
        const end = field + size;
        if (uncompressedSize === 0xffffffff && field + 8 <= end) {
          uncompressedSize = u64(view, field);
          field += 8;
        }
        if (compressedSize === 0xffffffff && field + 8 <= end) {
          compressedSize = u64(view, field);
          field += 8;
        }
        if (localHeaderOffset === 0xffffffff && field + 8 <= end) {
          localHeaderOffset = u64(view, field);
        }
        found = true;
        break;
      }
      extraAt += 4 + size;
    }
    if (!found) throw new ZipReadError('corrupt', 'The archive is damaged (missing ZIP64 sizes).');
  }

  return {
    entry: {
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      nameBytes,
      modifiedAt: dosDateToDate(date, time),
    },
    length,
  };
}

/**
 * Lists an archive from its central directory only. Reads at most
 * MAX_CENTRAL_DIRECTORY_BYTES plus the EOCD tail — never the entry data, so the
 * cost does not grow with the archive's size.
 */
export async function readZipListing(
  source: ByteSource,
  options: { maxEntries?: number; maxCentralDirectoryBytes?: number } = {},
): Promise<ZipListing> {
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxCdBytes = options.maxCentralDirectoryBytes ?? MAX_CENTRAL_DIRECTORY_BYTES;

  const eocd = await readEndOfCentralDirectory(source);
  if (eocd.totalEntries > maxEntries) {
    throw new ZipReadError('too-large', 'This archive has too many files to preview here.');
  }
  if (eocd.cdSize > maxCdBytes) {
    throw new ZipReadError('too-large', 'This archive has too many files to preview here.');
  }
  assertRange(eocd.cdOffset, eocd.cdSize, source.size, 'central directory');
  if (eocd.cdSize === 0) {
    return { entries: [], totalUncompressed: 0, entryCount64: eocd.zip64, archiveSize: source.size };
  }

  const cd = await source.read(eocd.cdOffset, eocd.cdSize);
  if (cd.length !== eocd.cdSize) throw new ZipReadError('corrupt', 'The archive is damaged (short central directory).');

  const entries: ZipEntryMeta[] = [];
  let totalUncompressed = 0;
  let offset = 0;
  while (offset + 46 <= cd.length) {
    const { entry, length } = parseCentralEntry(cd, offset);
    const utf8 = (entry.flags & 0x0800) !== 0;
    const path = decodeZipName(entry.nameBytes, utf8);
    const isFolder = path.endsWith('/') || path.endsWith('\\');
    const cleanPath = isFolder ? path.slice(0, -1) : path;
    const segments = cleanPath.split(/[/\\]/);
    entries.push({
      path: cleanPath,
      name: segments[segments.length - 1] || cleanPath,
      isFolder,
      uncompressedSize: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      method: entry.method,
      flags: entry.flags,
      crc32: entry.crc32,
      localHeaderOffset: entry.localHeaderOffset,
      modifiedAt: entry.modifiedAt,
      utf8,
      unsafeName: unsafeZipName(cleanPath),
    });
    if (!isFolder) totalUncompressed += entry.uncompressedSize;
    offset += length;
    if (entries.length > maxEntries) {
      throw new ZipReadError('too-large', 'This archive has too many files to preview here.');
    }
  }

  return {
    entries,
    totalUncompressed,
    entryCount64: eocd.zip64,
    archiveSize: source.size,
  };
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Reads ONE entry's bytes, bounded twice: the declared size is checked before
 * any data is fetched, and deflate output is aborted the moment it passes the
 * cap (so a zip bomb costs at most `maxOutputBytes`).
 */
export async function readZipEntry(
  source: ByteSource,
  entry: Pick<ZipEntryMeta, 'method' | 'flags' | 'compressedSize' | 'uncompressedSize' | 'localHeaderOffset'>,
  options: { maxOutputBytes?: number } = {},
): Promise<Uint8Array> {
  const cap = options.maxOutputBytes ?? MAX_ENTRY_BYTES;
  if ((entry.flags & 0x0001) !== 0) {
    throw new ZipReadError('encrypted', 'This file is password-protected and cannot be previewed here.');
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipReadError('unsupported-method', 'This compression method cannot be previewed here.');
  }
  if (entry.uncompressedSize > cap) {
    throw new ZipReadError('too-large', 'This file is too large to open here.');
  }
  assertRange(entry.localHeaderOffset, 30, source.size, 'local header');
  const local = await source.read(entry.localHeaderOffset, 30);
  const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
  if (u32(localView, 0) !== SIG_LOCAL) {
    throw new ZipReadError('corrupt', 'The archive is damaged (bad local header).');
  }
  const nameLength = u16(localView, 26);
  const extraLength = u16(localView, 28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  assertRange(dataOffset, entry.compressedSize, source.size, 'file data');

  if (entry.method === 0) {
    if (entry.compressedSize > cap) {
      throw new ZipReadError('too-large', 'This file is too large to open here.');
    }
    const data = await source.read(dataOffset, entry.compressedSize);
    if (data.length !== entry.compressedSize) {
      throw new ZipReadError('corrupt', 'The archive is damaged (short file data).');
    }
    if (data.length !== entry.uncompressedSize) {
      throw new ZipReadError('corrupt', 'The archive is damaged (sizes disagree).');
    }
    return data;
  }

  // Deflate: inflate as it streams, aborting above the cap.
  // pako is imported lazily so the library only enters the bundle with this path.
  const { Inflate } = await import('pako');
  // ZIP method 8 is RAW deflate (no zlib wrapper): `raw: true` is required.
  const inflater = new Inflate({ raw: true, chunkSize: 64 * 1024 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  // pako flushes through onData as the output buffer fills (and at the end).
  // Counting here — rather than after the loop — is what stops a zip bomb at
  // the cap instead of after it has inflated completely. Throwing from the
  // callback aborts the current push() instead of letting the rest of a 256 KB
  // input chunk expand first, so one read cannot blow past the cap.
  inflater.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > cap) {
      throw new ZipReadError('too-large', 'This file is too large to open here.');
    }
    chunks.push(chunk);
  };
  let consumed = 0;
  try {
    while (consumed < entry.compressedSize) {
      const length = Math.min(READ_CHUNK_BYTES, entry.compressedSize - consumed);
      const chunk = await source.read(dataOffset + consumed, length);
      if (chunk.length !== length) throw new ZipReadError('corrupt', 'The archive is damaged (short file data).');
      consumed += length;
      inflater.push(chunk, consumed === entry.compressedSize);
      if (inflater.err) {
        throw new ZipReadError('corrupt', 'The archive is damaged (this file could not be decompressed).');
      }
    }
  } catch (err) {
    // The cap abort travels out through pako's onData; keep it as its own code.
    if (err instanceof ZipReadError) throw err;
    throw new ZipReadError('corrupt', 'The archive is damaged (this file could not be decompressed).');
  }
  const data = concatChunks(chunks, total);
  if (data.length !== entry.uncompressedSize) {
    throw new ZipReadError('corrupt', 'The archive is damaged (sizes disagree).');
  }
  return data;
}
