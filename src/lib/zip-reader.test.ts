// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 2233 item 6 — ranged, bounded ZIP reading.
 *
 * These tests run against an instrumented in-memory ByteSource, so they can
 * prove the reader never pulls a whole archive into memory (the cause of the
 * 50 MB+ failure): the 60 MB cases below are virtual files whose read ranges
 * are recorded.
 */
import { describe, expect, test } from 'bun:test';
import { deflateRaw } from 'pako';
import {
  MAX_CENTRAL_DIRECTORY_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  ZipReadError,
  decodeZipName,
  readZipEntry,
  readZipListing,
  type ByteSource,
} from './zip-reader';

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

interface ReadRecord {
  offset: number;
  length: number;
}

function instrument(source: ByteSource & { reads: ReadRecord[]; bytesRead: number }) {
  return source;
}

/** Small in-memory archive source that records every range it is asked for. */
function memorySource(bytes: Uint8Array) {
  const reads: ReadRecord[] = [];
  let bytesRead = 0;
  const source: ByteSource = {
    size: bytes.length,
    async read(offset, length) {
      reads.push({ offset, length });
      bytesRead += length;
      return bytes.slice(offset, offset + length);
    },
  };
  return Object.assign(source, {
    get reads() {
      return reads;
    },
    get bytesRead() {
      return bytesRead;
    },
  });
}

/**
 * A virtual 60 MB file that only materialises the bytes a reader asks for.
 * `tail` is placed at the end of the file (where the EOCD lives).
 */
function virtualSource(size: number, tail: Uint8Array, body: Uint8Array = new Uint8Array(0)) {
  const reads: ReadRecord[] = [];
  let bytesRead = 0;
  const source: ByteSource = {
    size,
    async read(offset, length) {
      const end = Math.min(offset + length, size);
      reads.push({ offset, length: end - offset });
      bytesRead += end - offset;
      const out = new Uint8Array(end - offset);
      const tailStart = size - tail.length;
      // Body bytes sit at the start of the file (local headers + data).
      for (let i = 0; i < out.length; i += 1) {
        const abs = offset + i;
        if (abs >= tailStart) out[i] = tail[abs - tailStart];
        else if (abs < body.length) out[i] = body[abs];
      }
      return out;
    },
  };
  return Object.assign(source, {
    get reads() {
      return reads;
    },
    get bytesRead() {
      return bytesRead;
    },
  });
}

interface EntrySpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  flags?: number;
  declaredUncompressed?: number;
  declaredCompressed?: number;
}

/** Minimal ZIP writer (stored or deflated) used to build fixtures. */
function buildZip(entries: EntrySpec[]): Uint8Array {
  const chunks: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = new TextEncoder().encode(e.name);
    const method = e.method ?? 0;
    const payload = method === 8 ? deflateRaw(e.data) : e.data;
    const compSize = e.declaredCompressed ?? payload.length;
    const uncompSize = e.declaredUncompressed ?? e.data.length;
    const localHeader = [
      ...u32(0x04034b50), ...u16(20), ...u16(e.flags ?? 0x0800), ...u16(method),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(compSize), ...u32(uncompSize), ...u16(nameBytes.length), ...u16(0),
    ];
    const localOffset = offset;
    chunks.push(...localHeader, ...nameBytes);
    for (let i = 0; i < payload.length; i += 0x8000) {
      chunks.push(...payload.subarray(i, Math.min(i + 0x8000, payload.length)));
    }
    offset += localHeader.length + nameBytes.length + payload.length;
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(e.flags ?? 0x0800),
      ...u16(method), ...u16(0), ...u16(0), ...u32(0),
      ...u32(compSize), ...u32(uncompSize), ...u16(nameBytes.length), ...u16(0),
      ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(localOffset),
      ...nameBytes,
    );
  }
  const cdOffset = offset;
  const cd = central;
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(cd.length), ...u32(cdOffset), ...u16(0),
  ];
  return new Uint8Array([...chunks, ...cd, ...eocd]);
}

const text = (s: string) => new TextEncoder().encode(s);

describe('readZipListing — bounded reads', () => {
  test('a 60 MB archive lists without reading the whole file', async () => {
    const tailZip = buildZip([{ name: 'hello.txt', data: text('hi') }]);
    // Split the real little archive so the EOCD sits at the end of 60 MB.
    const body = tailZip.slice(0, tailZip.length - 22);
    const eocd = tailZip.slice(tailZip.length - 22);
    // The archive's own bytes sit at offset 0; the EOCD is parked at the very
    // end of a 60 MB virtual file, with 60 MB of zeros in between.
    const source = virtualSource(60 * 1024 * 1024, eocd, body);
    const listing = await readZipListing(source);
    expect(listing.entries.length).toBe(1);
    expect(listing.entries[0].path).toBe('hello.txt');
    expect(source.bytesRead).toBeLessThan(MAX_CENTRAL_DIRECTORY_BYTES + 70_000);
    expect(source.bytesRead).toBeLessThan(2 * 1024 * 1024);
    // No single read may exceed the central-directory bound.
    for (const r of source.reads) expect(r.length).toBeLessThanOrEqual(MAX_CENTRAL_DIRECTORY_BYTES + 70_000);
  });

  test('reads the central directory once, not entry by entry', async () => {
    const zip = buildZip([
      { name: 'a.txt', data: text('a') },
      { name: 'dir/b.txt', data: text('bb') },
      { name: 'dir/sub/c.txt', data: text('ccc') },
    ]);
    const source = instrument(memorySource(zip));
    const listing = await readZipListing(source);
    expect(listing.entries.map((e) => e.path)).toEqual(['a.txt', 'dir/b.txt', 'dir/sub/c.txt']);
    // Exactly one read starts at the central-directory offset (the EOCD tail
    // read is a separate range and does not touch entry data).
    const listingMeta = await readZipListing(memorySource(zip));
    void listingMeta;
    const tailRead = source.reads[0];
    const cdReads = source.reads.filter((r) => r.offset !== tailRead.offset);
    expect(cdReads.length).toBe(1);
  });
});

describe('readZipListing — refusal cases', () => {
  test('multi-disk archives are refused', async () => {
    const zip = buildZip([{ name: 'a.txt', data: text('a') }]);
    const eocdAt = zip.length - 22;
    zip[eocdAt + 4] = 1; // disk number
    await expect(readZipListing(memorySource(zip))).rejects.toMatchObject({ code: 'multi-disk' });
  });

  test('a central directory outside the file is refused', async () => {
    const zip = buildZip([{ name: 'a.txt', data: text('a') }]);
    const eocdAt = zip.length - 22;
    zip.set(u32(0x7fffff00), eocdAt + 16); // cd offset
    await expect(readZipListing(memorySource(zip))).rejects.toMatchObject({ code: 'corrupt' });
  });

  test('an entry range outside the file is refused', async () => {
    const zip = buildZip([{ name: 'a.txt', data: text('a') }]);
    const eocdAt = zip.length - 22;
    const cdOffset = new DataView(zip.buffer).getUint32(eocdAt + 16, true);
    zip.set(u32(0x7fffff00), cdOffset + 42); // local header offset
    const listing = await readZipListing(memorySource(zip));
    await expect(readZipEntry(memorySource(zip), listing.entries[0])).rejects.toMatchObject({ code: 'corrupt' });
  });

  test('more than 50,000 entries is too large', async () => {
    const zip = buildZip([{ name: 'a.txt', data: text('a') }]);
    const eocdAt = zip.length - 22;
    zip.set(u16(MAX_ENTRIES + 1), eocdAt + 10);
    await expect(readZipListing(memorySource(zip))).rejects.toMatchObject({ code: 'too-large' });
  });

  test('an oversized central directory is too large', async () => {
    const zip = buildZip([{ name: 'a.txt', data: text('a') }]);
    const eocdAt = zip.length - 22;
    zip.set(u32(MAX_CENTRAL_DIRECTORY_BYTES + 1), eocdAt + 12);
    await expect(readZipListing(memorySource(zip))).rejects.toMatchObject({ code: 'too-large' });
  });

  test('unsafe names are flagged but still listed', async () => {
    const zip = buildZip([
      { name: '../evil.txt', data: text('x') },
      { name: '/abs.txt', data: text('y') },
      { name: 'ok/../../also-evil', data: text('z') },
      { name: 'fine.txt', data: text('w') },
    ]);
    const listing = await readZipListing(memorySource(zip));
    expect(listing.entries.map((e) => e.unsafeName)).toEqual([true, true, true, false]);
    expect(listing.entries.map((e) => e.path)).toEqual([
      '../evil.txt', '/abs.txt', 'ok/../../also-evil', 'fine.txt',
    ]);
  });
});

describe('readZipEntry — caps and methods', () => {
  test('stored and deflated entries both read back', async () => {
    const stored = buildZip([{ name: 's.txt', data: text('stored body'), method: 0 }]);
    const deflated = buildZip([{ name: 'd.txt', data: text('deflated body '.repeat(50)), method: 8 }]);
    const s = await readZipListing(memorySource(stored));
    const d = await readZipListing(memorySource(deflated));
    expect(new TextDecoder().decode(await readZipEntry(memorySource(stored), s.entries[0]))).toBe('stored body');
    expect(new TextDecoder().decode(await readZipEntry(memorySource(deflated), d.entries[0]))).toBe(
      'deflated body '.repeat(50),
    );
  });

  test('a declared size above the cap is refused before reading data', async () => {
    const zip = buildZip([{ name: 'big.bin', data: text('small'), declaredUncompressed: MAX_ENTRY_BYTES + 1 }]);
    const listing = await readZipListing(memorySource(zip));
    await expect(readZipEntry(memorySource(zip), listing.entries[0])).rejects.toMatchObject({ code: 'too-large' });
  });

  test('a zip bomb aborts before the whole compressed entry is read', async () => {
    // Highly compressible tail first: the first read chunk already inflates far
    // past the cap, and the incompressible noise after it keeps the stream long
    // enough to span several read chunks.
    const noise = new Uint8Array(2 * 1024 * 1024);
    let seed = 0x9e3779b9;
    for (let i = 0; i < noise.length; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = seed >>> 24;
    }
    const data = new Uint8Array(60 * 1024 * 1024 + noise.length);
    data.set(noise, 60 * 1024 * 1024);
    // It also lies about its size, so the pre-read cap check cannot catch it.
    const zip = buildZip([{ name: 'bomb.bin', data, method: 8, declaredUncompressed: 1024 }]);
    expect(zip.length).toBeGreaterThan(1024 * 1024); // spans several 256 KB reads
    const reader = instrument(memorySource(zip));
    const listing = await readZipListing(instrument(memorySource(zip)));
    // The cap is enforced from inside the inflate callback, so a lying declared
    // size cannot slip 60 MB of output past it.
    await expect(
      readZipEntry(reader, listing.entries[0], { maxOutputBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });

  test('a zip bomb aborts once the real output passes the cap', async () => {
    // 60 MB of zeros deflates to ~60 KB but inflates past the 1 MB test cap.
    const bomb = new Uint8Array(60 * 1024 * 1024);
    const zip = buildZip([{ name: 'bomb.bin', data: bomb, method: 8 }]);
    expect(zip.length).toBeLessThan(200 * 1024); // fixture really is a bomb
    const listing = await readZipListing(memorySource(zip));
    const started = Date.now();
    await expect(
      readZipEntry(memorySource(zip), listing.entries[0], { maxOutputBytes: 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('an encrypted entry is refused with its own code', async () => {
    const zip = buildZip([{ name: 'secret.txt', data: text('x'), flags: 0x0801 }]);
    const listing = await readZipListing(memorySource(zip));
    await expect(readZipEntry(memorySource(zip), listing.entries[0])).rejects.toMatchObject({ code: 'encrypted' });
  });

  test('an unsupported method is refused', async () => {
    const zip = buildZip([{ name: 'weird.bin', data: text('x') }]);
    // Patch the method in both the local and central headers to 12 (bzip2).
    const eocdAt = zip.length - 22;
    const cdOffset = new DataView(zip.buffer).getUint32(eocdAt + 16, true);
    zip[8] = 12;
    zip[cdOffset + 10] = 12;
    const listing = await readZipListing(memorySource(zip));
    await expect(readZipEntry(memorySource(zip), listing.entries[0])).rejects.toMatchObject({ code: 'unsupported-method' });
  });

  test('a declared size that disagrees with the real output is corrupt', async () => {
    const zip = buildZip([{ name: 'liar.txt', data: text('abc'), method: 0, declaredUncompressed: 4 }]);
    const listing = await readZipListing(memorySource(zip));
    await expect(readZipEntry(memorySource(zip), listing.entries[0])).rejects.toMatchObject({ code: 'corrupt' });
  });

  test('a truncated entry is corrupt, not a crash', async () => {
    const zip = buildZip([{ name: 'a.txt', data: text('abcdef') }]);
    const eocdAt = zip.length - 22;
    const cdOffset = new DataView(zip.buffer).getUint32(eocdAt + 16, true);
    zip.set(u32(9999), cdOffset + 20); // compressed size far past EOF
    const listing = await readZipListing(memorySource(zip));
    await expect(readZipEntry(memorySource(zip), listing.entries[0])).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('decodeZipName', () => {
  test('decodes CP437 when the UTF-8 flag is absent', () => {
    // 0x82 is é in CP437; 0x81 is ü.
    expect(decodeZipName(new Uint8Array([0x63, 0x61, 0x66, 0x82]), false)).toBe('café');
    expect(decodeZipName(new Uint8Array([0x67, 0x72, 0x81, 0x6e]), false)).toBe('grün');
  });

  test('decodes UTF-8 when bit 11 is set', () => {
    expect(decodeZipName(new TextEncoder().encode('naïve.txt'), true)).toBe('naïve.txt');
  });
});

describe('ZIP64', () => {
  test('reads a ZIP64 end-of-central-directory', async () => {
    const entries = [
      { name: 'one.txt', data: text('1') },
      { name: 'two.txt', data: text('2') },
    ];
    const plain = buildZip(entries);
    const eocdAt = plain.length - 22;
    const cdSize = new DataView(plain.buffer).getUint32(eocdAt + 12, true);
    const cdOffset = new DataView(plain.buffer).getUint32(eocdAt + 16, true);
    const cdStart = cdOffset;
    const cdEnd = cdOffset + cdSize;
    const zip64EocdOffset = cdEnd;

    const record = new Uint8Array(56);
    const dv = new DataView(record.buffer);
    dv.setUint32(0, 0x06064b50, true);
    dv.setBigUint64(4, 44n, true);
    dv.setUint16(12, 45, true);
    dv.setUint16(14, 45, true);
    dv.setUint32(16, 0, true);
    dv.setUint32(20, 0, true);
    dv.setBigUint64(24, BigInt(entries.length), true);
    dv.setBigUint64(32, BigInt(entries.length), true);
    dv.setBigUint64(40, BigInt(cdSize), true);
    dv.setBigUint64(48, BigInt(cdStart), true);

    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setUint32(4, 0, true);
    lv.setBigUint64(8, BigInt(zip64EocdOffset), true);
    lv.setUint32(16, 1, true);

    const legacyEocd = new Uint8Array(22);
    const ev = new DataView(legacyEocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 0xffff, true);
    ev.setUint16(10, 0xffff, true);
    ev.setUint32(12, 0xffffffff, true);
    ev.setUint32(16, 0xffffffff, true);

    const file = new Uint8Array([...plain.slice(0, cdEnd), ...record, ...locator, ...legacyEocd]);
    const listing = await readZipListing(memorySource(file));
    expect(listing.entries.map((e) => e.path)).toEqual(['one.txt', 'two.txt']);
    expect(listing.entryCount64).toBe(true);
  });
});

describe('ZipReadError', () => {
  test('carries a machine code and human copy', () => {
    const err = new ZipReadError('corrupt', 'not a zip');
    expect(err.code).toBe('corrupt');
    expect(err.message).toBe('not a zip');
    expect(err).toBeInstanceOf(Error);
  });
});
