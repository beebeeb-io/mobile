// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1569 — RAW camera preview. See raw-preview.ts's own doc comment for
// why the embedded-JPEG byte scan exists (exifr.thumbnail() only covered 2
// of the task's 6 real formats) and why EXIF is mapped separately from
// extraction (both are PURE — no I/O, no RN — so directly unit-testable).
// RED/GREEN mutation proof for this file is pasted in
// .claude/tasks/in-development/1569-mobile-raw-camera-preview.md's Notes.
import { describe, expect, test } from 'bun:test';
import {
  base64ToBytes,
  bytesToBase64,
  findJpegExifTiffOffset,
  findJpegSpans,
  findLargestJpegSpan,
  mapExifToRawInfo,
  parseTiffExifTags,
} from './raw-preview';

// ---------------------------------------------------------------------------
// Synthetic TIFF/EXIF byte-sequence builder — a real (if minimal) two-level
// TIFF: IFD0 (Make, Model, an ExifIFD pointer) -> Exif sub-IFD (LensModel,
// ISO, ExposureTime, FNumber, FocalLength). All offsets below are computed
// from the actual byte lengths as the buffer is assembled, not hardcoded —
// verified once against the real implementation while writing this file
// (166 total bytes, every field round-tripped correctly) before being
// committed here.
// ---------------------------------------------------------------------------

function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}
function asciiNul(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0)).concat([0]);
}
function rationalLE(num: number, den: number): number[] {
  return [...u32le(num), ...u32le(den)];
}

function buildSyntheticCanonTiff(): Uint8Array {
  const makeBytes = asciiNul('Canon');
  const modelBytes = asciiNul('EOS R5');
  const lensBytes = asciiNul('RF50mm F1.2L');
  const expBytes = rationalLE(1, 200); // 1/200s
  const fnumBytes = rationalLE(9, 5); // f/1.8
  const focalBytes = rationalLE(50, 1); // 50mm

  const ifd0EntryCount = 3;
  const ifd0Start = 8;
  const ifd0ExternalStart = ifd0Start + (2 + ifd0EntryCount * 12 + 4);
  const makeOffset = ifd0ExternalStart;
  const modelOffset = makeOffset + makeBytes.length;
  const exifIfdStart = modelOffset + modelBytes.length;

  const exifEntryCount = 5;
  const exifExternalStart = exifIfdStart + (2 + exifEntryCount * 12 + 4);
  const lensOffset = exifExternalStart;
  const expOffset = lensOffset + lensBytes.length;
  const fnumOffset = expOffset + expBytes.length;
  const focalOffset = fnumOffset + fnumBytes.length;

  const bytes: number[] = [];
  bytes.push(0x49, 0x49, ...u16le(42), ...u32le(ifd0Start)); // "II", magic 42, IFD0 offset
  bytes.push(...u16le(ifd0EntryCount));
  bytes.push(...u16le(0x010f), ...u16le(2), ...u32le(makeBytes.length), ...u32le(makeOffset));
  bytes.push(...u16le(0x0110), ...u16le(2), ...u32le(modelBytes.length), ...u32le(modelOffset));
  bytes.push(...u16le(0x8769), ...u16le(4), ...u32le(1), ...u32le(exifIfdStart));
  bytes.push(...u32le(0)); // next IFD offset (none)
  bytes.push(...makeBytes, ...modelBytes);
  bytes.push(...u16le(exifEntryCount));
  bytes.push(...u16le(0xa434), ...u16le(2), ...u32le(lensBytes.length), ...u32le(lensOffset));
  bytes.push(...u16le(0x8827), ...u16le(3), ...u32le(1), ...u16le(400), 0, 0); // ISO, inline SHORT
  bytes.push(...u16le(0x829a), ...u16le(5), ...u32le(1), ...u32le(expOffset));
  bytes.push(...u16le(0x829d), ...u16le(5), ...u32le(1), ...u32le(fnumOffset));
  bytes.push(...u16le(0x920a), ...u16le(5), ...u32le(1), ...u32le(focalOffset));
  bytes.push(...u32le(0)); // next IFD offset (none)
  bytes.push(...lensBytes, ...expBytes, ...fnumBytes, ...focalBytes);

  return new Uint8Array(bytes);
}

/** Minimal single-tag BIG-ENDIAN ("MM") TIFF — just enough to prove the
 * big-endian branch is exercised, separate from the little-endian builder
 * above (real cameras use both; CR2/DNG/ARW/NEF in this task's own fixtures
 * are all little-endian, so without this test the big-endian byte-order
 * path would be entirely unexercised). */
function buildMinimalBigEndianTiff(make: string): Uint8Array {
  const makeBytes = asciiNul(make);
  const ifd0Start = 8;
  const externalStart = ifd0Start + (2 + 1 * 12 + 4);
  const bytes: number[] = [];
  bytes.push(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, ifd0Start); // "MM", magic 42, IFD0 @ 8
  bytes.push(0x00, 0x01); // 1 entry
  bytes.push(0x01, 0x0f); // tag 0x010F (Make)
  bytes.push(0x00, 0x02); // type 2 (ASCII)
  bytes.push(0x00, 0x00, 0x00, makeBytes.length); // count
  bytes.push(0x00, 0x00, 0x00, externalStart); // offset (big-endian)
  bytes.push(0x00, 0x00, 0x00, 0x00); // next IFD offset
  bytes.push(...makeBytes);
  return new Uint8Array(bytes);
}

function wrapAsJpegWithExifApp1(tiffBytes: Uint8Array): Uint8Array {
  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const app1PayloadLen = 2 + exifHeader.length + tiffBytes.length; // includes the length field itself
  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe1, // APP1
    (app1PayloadLen >> 8) & 0xff,
    app1PayloadLen & 0xff,
    ...exifHeader,
    ...Array.from(tiffBytes),
    0xff,
    0xda,
    0x00,
    0x04,
    0x00,
    0x00, // minimal SOS header
    0x01,
    0x02, // a couple of "entropy" bytes
    0xff,
    0xd9, // EOI
  ];
  return new Uint8Array(bytes);
}

// ---------------------------------------------------------------------------
// Synthetic JPEG byte-sequence builder — just enough real marker structure
// (SOI, one ordinary length-prefixed segment, an SOS header, entropy data,
// EOI) for the scanner's state machine to walk correctly. Not a real
// decodable image — findJpegSpans never decodes pixels, only marker bytes.
// ---------------------------------------------------------------------------

function marker(code: number, payload: number[] = []): number[] {
  const len = payload.length + 2; // JPEG segment length INCLUDES itself
  return [0xff, code, (len >> 8) & 0xff, len & 0xff, ...payload];
}

function buildFakeJpeg(entropyBytes: number[] = [1, 2, 3]): number[] {
  const soi = [0xff, 0xd8];
  const app0 = marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
  const sosHeader = marker(0xda, [0x00, 0x00]); // minimal fake SOS header
  const eoi = [0xff, 0xd9];
  return [...soi, ...app0, ...sosHeader, ...entropyBytes, ...eoi];
}

describe('findJpegSpans', () => {
  test('finds exactly one span spanning a single well-formed fake JPEG', () => {
    const bytes = new Uint8Array(buildFakeJpeg());
    const spans = findJpegSpans(bytes);
    expect(spans).toEqual([{ start: 0, end: bytes.length }]);
  });

  test('returns [] for bytes with no JPEG markers at all', () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(findJpegSpans(bytes)).toEqual([]);
  });

  test('returns [] for a truncated JPEG (SOI present, EOI never arrives)', () => {
    const full = buildFakeJpeg();
    const truncated = full.slice(0, full.length - 2); // drop the EOI
    expect(findJpegSpans(new Uint8Array(truncated))).toEqual([]);
  });

  test('finds a span embedded after leading junk bytes, at the right offset', () => {
    const junk = [0xaa, 0xbb, 0xcc, 0xdd, 0xee];
    const jpeg = buildFakeJpeg();
    const bytes = new Uint8Array([...junk, ...jpeg]);
    const spans = findJpegSpans(bytes);
    expect(spans).toEqual([{ start: junk.length, end: junk.length + jpeg.length }]);
  });

  test('finds two separate spans, back to back with junk between them', () => {
    const jpeg1 = buildFakeJpeg([1, 2, 3]);
    const junk = [0x00, 0x00, 0x00];
    const jpeg2 = buildFakeJpeg([4, 5, 6, 7]);
    const bytes = new Uint8Array([...jpeg1, ...junk, ...jpeg2]);
    const spans = findJpegSpans(bytes);
    expect(spans.length).toBe(2);
    expect(spans[0]).toEqual({ start: 0, end: jpeg1.length });
    expect(spans[1]).toEqual({ start: jpeg1.length + junk.length, end: bytes.length });
  });

  test('a stuffed 0xFF 0x00 byte pair inside entropy data does NOT terminate the scan early', () => {
    // Real encoders escape any literal 0xFF in scan data as 0xFF 0x00. A
    // naive `indexOf(0xFFD9)` scanner would not be fooled by 0xFF 0x00
    // specifically, but WOULD stop at the first accidental 0xFFD9-shaped
    // byte pair anywhere in the entropy stream. This proves the real
    // marker-segment walk in scanForEoi treats the stuffed byte as opaque
    // scan data and keeps going to the ACTUAL trailing EOI, not a shorter
    // span.
    const entropy = [0x01, 0x02, 0xff, 0x00, 0x03, 0x04, 0x05];
    const bytes = new Uint8Array(buildFakeJpeg(entropy));
    const spans = findJpegSpans(bytes);
    expect(spans).toEqual([{ start: 0, end: bytes.length }]);
  });

  test('an RSTn restart marker inside entropy data does NOT terminate the scan early', () => {
    const entropy = [0x01, 0xff, 0xd0, 0x02, 0x03]; // 0xFFD0 = RST0
    const bytes = new Uint8Array(buildFakeJpeg(entropy));
    const spans = findJpegSpans(bytes);
    expect(spans).toEqual([{ start: 0, end: bytes.length }]);
  });
});

describe('findLargestJpegSpan', () => {
  test('returns null when nothing is found', () => {
    expect(findLargestJpegSpan(new Uint8Array([0, 1, 2, 3]))).toBeNull();
  });

  test('a span below the minimum-size floor is found by findJpegSpans but excluded here', () => {
    const bytes = new Uint8Array(buildFakeJpeg()); // a few dozen bytes, well under the 4096 floor
    expect(findJpegSpans(bytes).length).toBe(1);
    expect(findLargestJpegSpan(bytes)).toBeNull();
  });

  test('picks the LARGER of two qualifying spans, not just the first', () => {
    const filler = (n: number) => new Array(n).fill(0);
    const small = buildFakeJpeg(filler(4200)); // just over the floor
    const large = buildFakeJpeg(filler(9000)); // clearly larger
    const bytes = new Uint8Array([...small, 0x00, 0x00, ...large]);
    const span = findLargestJpegSpan(bytes);
    expect(span).not.toBeNull();
    expect(span!.end - span!.start).toBe(large.length);
    expect(span!.start).toBe(small.length + 2); // after the 2 junk bytes
  });
});

describe('mapExifToRawInfo', () => {
  test('returns null for null/undefined input', () => {
    expect(mapExifToRawInfo(null)).toBeNull();
    expect(mapExifToRawInfo(undefined)).toBeNull();
  });

  test('returns null when no field resolves to anything', () => {
    expect(mapExifToRawInfo({})).toBeNull();
    expect(mapExifToRawInfo({ ISO: 0, FNumber: 0, ExposureTime: 0, FocalLength: 0 })).toBeNull();
  });

  test('real Canon CR2 tag shape (raw.pixls.us sample.cr2, verified via exifr)', () => {
    const info = mapExifToRawInfo({
      Make: 'Canon',
      Model: 'Canon EOS 40D',
      ISO: 100,
      ExposureTime: 1.3,
      FNumber: 8,
      FocalLength: 38,
    });
    expect(info).toEqual({
      cameraModel: 'Canon EOS 40D', // Model already includes Make — deduped
      lensModel: null,
      iso: 'ISO 100',
      shutterSpeed: '1.3s',
      aperture: 'f/8',
      focalLength: '38mm',
    });
  });

  test('real Sony ARW tag shape — dashes-only LensModel treated as absent, FNumber/FocalLength of 0 treated as absent', () => {
    const info = mapExifToRawInfo({
      Make: 'SONY',
      Model: 'ILCE-7S',
      LensModel: '----',
      ISO: 400,
      ExposureTime: 0.004,
      FNumber: 0,
      FocalLength: 0,
    });
    expect(info).toEqual({
      cameraModel: 'SONY ILCE-7S',
      lensModel: null,
      iso: 'ISO 400',
      shutterSpeed: '1/250s',
      aperture: null,
      focalLength: null,
    });
  });

  test('real Adobe DNG tag shape — a real LensModel passes through', () => {
    const info = mapExifToRawInfo({
      Make: 'Canon',
      Model: 'Canon EOS 5D Mark III',
      LensModel: 'EF70-200mm f/2.8L IS II USM',
      ISO: 200,
      ExposureTime: 0.008,
      FNumber: 2.8,
      FocalLength: 70,
    });
    expect(info).toEqual({
      cameraModel: 'Canon EOS 5D Mark III',
      lensModel: 'EF70-200mm f/2.8L IS II USM',
      iso: 'ISO 200',
      shutterSpeed: '1/125s',
      aperture: 'f/2.8',
      focalLength: '70mm',
    });
  });

  test('real Fujifilm RAF (embedded-JPEG EXIF) tag shape — sub-1/1000s exposure', () => {
    const info = mapExifToRawInfo({
      Make: 'FUJIFILM',
      Model: 'FinePix S5000',
      ISO: 200,
      ExposureTime: 0.0014705882352941176,
      FNumber: 6.3,
      FocalLength: 5.7,
    });
    expect(info).toEqual({
      cameraModel: 'FUJIFILM FinePix S5000',
      lensModel: null,
      iso: 'ISO 200',
      shutterSpeed: '1/680s',
      aperture: 'f/6.3',
      focalLength: '5.7mm',
    });
  });

  test('at least one populated field is enough to return a non-null result', () => {
    expect(mapExifToRawInfo({ Make: 'Canon' })).toEqual({
      cameraModel: 'Canon',
      lensModel: null,
      iso: null,
      shutterSpeed: null,
      aperture: null,
      focalLength: null,
    });
  });

  test('shutter speed at exactly 1 second reads "1s", not "1/1s"', () => {
    const info = mapExifToRawInfo({ ExposureTime: 1 });
    expect(info?.shutterSpeed).toBe('1s');
  });

  test('shutter speed just under 1 second still reads whole seconds, not a degenerate 1/1s', () => {
    const info = mapExifToRawInfo({ ExposureTime: 0.999 });
    expect(info?.shutterSpeed).toBe('1s');
  });

  test('a LensModel of any length of dashes is treated as absent', () => {
    // Make is included so the result isn't null outright (which would make
    // this assertion pass vacuously regardless of the dashes handling) —
    // this isolates the LensModel field specifically.
    const info = mapExifToRawInfo({ Make: 'Test', LensModel: '--------' });
    expect(info).not.toBeNull();
    expect(info?.lensModel).toBeNull();
  });

  test('a real (non-dashes) LensModel of unusual length still passes through', () => {
    const info = mapExifToRawInfo({ Make: 'Test', LensModel: '-50mm f/1.8-' });
    expect(info?.lensModel).toBe('-50mm f/1.8-');
  });
});

describe('parseTiffExifTags', () => {
  test('reads Make/Model/LensModel/ISO/ExposureTime/FNumber/FocalLength from a real two-level TIFF (IFD0 -> Exif sub-IFD)', () => {
    const bytes = buildSyntheticCanonTiff();
    expect(parseTiffExifTags(bytes)).toEqual({
      Make: 'Canon',
      Model: 'EOS R5',
      LensModel: 'RF50mm F1.2L',
      ISO: 400,
      ExposureTime: 0.005,
      FNumber: 1.8,
      FocalLength: 50,
    });
  });

  test('reads a big-endian ("MM") TIFF correctly', () => {
    const bytes = buildMinimalBigEndianTiff('FUJIFILM');
    expect(parseTiffExifTags(bytes)).toEqual({ Make: 'FUJIFILM' });
  });

  test('returns null for a buffer with neither "II" nor "MM" at the start offset', () => {
    const bytes = new Uint8Array([0x00, 0x00, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0, 0]);
    expect(parseTiffExifTags(bytes)).toBeNull();
  });

  test('returns null when the magic number after the byte-order mark is not 42', () => {
    const bytes = new Uint8Array([0x49, 0x49, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0, 0]);
    expect(parseTiffExifTags(bytes)).toBeNull();
  });

  test('returns null for random bytes (the corrupt-file case)', () => {
    // Same seeded generator as e2e/fixtures/preview-matrix/raw/corrupt.cr2,
    // reproduced small here so the test has no file dependency.
    const bytes = new Uint8Array([0x8f, 0x02, 0xd1, 0x77, 0x4a, 0x00, 0x9c, 0x11, 0x63, 0xfe, 0x3b, 0x81]);
    expect(parseTiffExifTags(bytes)).toBeNull();
  });

  test('returns null for a buffer too short to hold a TIFF header', () => {
    expect(parseTiffExifTags(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBeNull();
  });

  test('returns null when the IFD has no tags this reader recognizes', () => {
    // A well-formed TIFF whose one entry is a tag this reader doesn't map
    // (0x0112 Orientation) — the walk completes but `out` stays empty.
    const bytes = new Uint8Array([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // header, IFD0 @ 8
      0x01, 0x00, // 1 entry
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, // Orientation=1
      0x00, 0x00, 0x00, 0x00, // next IFD
    ]);
    expect(parseTiffExifTags(bytes)).toBeNull();
  });

  test('a RATIONAL with a zero denominator is skipped, not returned as Infinity/NaN', () => {
    // Same shape as the real builder's Exif sub-IFD, but FNumber's rational
    // denominator is 0 — a malformed-but-plausible real-world value some
    // cameras do write for "not applicable".
    const ifd0Start = 8;
    const ifd0ExternalStart = ifd0Start + (2 + 1 * 12 + 4);
    const bytes = new Uint8Array([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // header, IFD0 @ 8
      0x01, 0x00, // 1 entry
      0x9d, 0x82, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, ifd0ExternalStart, 0x00, 0x00, 0x00, // FNumber (RATIONAL, external)
      0x00, 0x00, 0x00, 0x00, // next IFD
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // numerator=0, denominator=0
    ]);
    expect(parseTiffExifTags(bytes)).toBeNull();
  });

  test('a corrupt/out-of-bounds value offset is skipped rather than throwing', () => {
    // Same shape as the real builder's IFD0, but the Make entry's offset
    // points past the end of the buffer — must not throw, and must still
    // recover the OTHER, valid tags.
    const bytes = new Uint8Array([
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // header, IFD0 @ 8
      0x02, 0x00, // 2 entries
      0x0f, 0x01, 0x02, 0x00, 0x06, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, // Make -> bogus offset 65535
      0x27, 0x88, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, // ISO=100, inline
      0x00, 0x00, 0x00, 0x00, // next IFD
    ]);
    expect(() => parseTiffExifTags(bytes)).not.toThrow();
    expect(parseTiffExifTags(bytes)).toEqual({ ISO: 100 });
  });
});

describe('findJpegExifTiffOffset', () => {
  test('finds the TIFF offset inside a real APP1 "Exif\\0\\0" segment', () => {
    const tiff = buildMinimalBigEndianTiff('NIKON CORPORATION');
    const jpeg = wrapAsJpegWithExifApp1(tiff);
    const offset = findJpegExifTiffOffset(jpeg);
    expect(offset).not.toBeNull();
    expect(parseTiffExifTags(jpeg, offset!)).toEqual({ Make: 'NIKON CORPORATION' });
  });

  test('returns null for a JPEG with no APP1 Exif segment at all', () => {
    // SOI, a plain APP0/JFIF segment, SOS, entropy data, EOI — no APP1.
    const jpeg = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, empty-ish payload
      0xff, 0xda, 0x00, 0x04, 0x00, 0x00, // SOS header
      0x01, 0x02, // entropy data
      0xff, 0xd9, // EOI
    ]);
    expect(findJpegExifTiffOffset(jpeg)).toBeNull();
  });

  test('returns null for bytes with no JPEG structure at all', () => {
    expect(findJpegExifTiffOffset(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBeNull();
  });

  test('does not scan past the Start Of Scan marker looking for APP1', () => {
    // An APP1-shaped Exif signature placed AFTER the SOS marker (i.e. inside
    // what would be entropy-coded data) must NOT be found — real APP1
    // segments only ever precede SOS.
    const fakeExifPastSos = [0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    const jpeg = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xda, 0x00, 0x04, 0x00, 0x00, // SOS header
      ...fakeExifPastSos,
      0xff, 0xd9, // EOI
    ]);
    expect(findJpegExifTiffOffset(jpeg)).toBeNull();
  });
});

describe('bytesToBase64 / base64ToBytes', () => {
  test('round-trips every byte value 0-255', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test('matches a known base64 value for a short ASCII string', () => {
    const bytes = new Uint8Array([...'Beebeeb.io'].map((c) => c.charCodeAt(0)));
    expect(bytesToBase64(bytes)).toBe('QmVlYmVlYi5pbw==');
  });

  test('round-trips a buffer larger than one 0x8000-byte chunk, correctly across the boundary', () => {
    // Real-bug regression (task 1569): an earlier `bytesToBase64` built the
    // binary string in 0x8000-byte chunks via
    // `String.fromCharCode(...Array.from(chunk))` — correct under Bun/V8 in
    // every test here, but produced a JPEG on-device (bb-ios27, Release,
    // Hermes) whose HEADERS were intact (valid per `sips`/`file`, correct
    // reported dimensions) while its entropy-coded body was corrupted badly
    // enough that neither `<Image>`'s decode nor a real decoder (Pillow)
    // could read it. No small synthetic byte sequence in this file
    // reproduced that failure (it needed a real multi-megabyte file on a
    // real device) — this test instead pins the CONTRACT the fix restores
    // (a plain one-char-at-a-time loop, matching this codebase's OTHER
    // base64 encoders): exact round-tripping across and past a chunk-sized
    // boundary, with a non-repeating pattern so a byte-order or off-by-one
    // shift at the boundary cannot hide behind a repeated value.
    const size = 0x8000 * 2 + 137; // spans two old "chunks" plus a remainder
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 37 + 11) & 0xff;
    const roundTripped = base64ToBytes(bytesToBase64(bytes));
    expect(roundTripped.length).toBe(bytes.length);
    expect(roundTripped).toEqual(bytes);
    // Explicitly re-check the exact bytes straddling the old chunk boundary.
    for (let i = 0x8000 - 3; i <= 0x8000 + 3; i++) {
      expect(roundTripped[i]).toBe(bytes[i]!);
    }
  });

  test('base64ToBytes decodes what bytesToBase64 encodes for an empty buffer', () => {
    expect(base64ToBytes(bytesToBase64(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });
});

// ---------------------------------------------------------------------------
// Synthetic JPEG-with-a-real-SOF0-marker builder, for findLargestJpegSpan's
// plausibility filter. Real bug this guards (task 1569, sample.cr2, see
// findLargestJpegSpan's own doc comment): RAW sensor data following a real
// embedded preview can coincidentally form a complete, larger, well-formed
// "JPEG" that decodes to noise — the real fixture's fake span declared
// 1944×1296 for 4.45MB (1.77 bytes/pixel) while its OWN real, smaller,
// 366KB preview was 0.15 bytes/pixel. These tests reproduce that SHAPE
// (a bigger implausible span vs. a smaller plausible one) synthetically.
// ---------------------------------------------------------------------------

function buildJpegWithSof0(width: number, height: number, entropyByteCount: number): number[] {
  const soi = [0xff, 0xd8];
  const app0 = marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]); // "JFIF\0"
  const sof0Payload = [
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, // 1 component (grayscale) — enough to exercise the parser, not a real encoder
    0x01,
    0x11,
    0x00,
  ];
  const sof0 = marker(0xc0, sof0Payload);
  const sosHeader = marker(0xda, [0x01, 0x00, 0x3f, 0x00]);
  const entropy = new Array(entropyByteCount).fill(0); // all-zero: never 0xFF, never confused for a marker
  const eoi = [0xff, 0xd9];
  return [...soi, ...app0, ...sof0, ...sosHeader, ...entropy, ...eoi];
}

describe('findLargestJpegSpan — SOF-declared-dimensions plausibility filter', () => {
  test('skips a LARGER span whose declared dimensions are implausible for its byte size, picking the smaller plausible one instead', () => {
    // "fake": 50×50 (2500px) padded to ~20KB -> ~8 bytes/pixel — implausible.
    const fake = buildJpegWithSof0(50, 50, 20000);
    // "real": 200×200 (40000px) padded to ~5KB -> ~0.125 bytes/pixel — plausible.
    const real = buildJpegWithSof0(200, 200, 5000);
    expect(fake.length).toBeGreaterThan(real.length); // the implausible one really is larger
    const bytes = new Uint8Array([...fake, 0x00, 0x00, 0x00, ...real]);
    const span = findLargestJpegSpan(bytes);
    expect(span).not.toBeNull();
    expect(span!.end - span!.start).toBe(real.length);
    expect(span!.start).toBe(fake.length + 3);
  });

  test('still picks the larger span when both are plausible', () => {
    const small = buildJpegWithSof0(200, 200, 5000); // ~0.125 bytes/pixel
    const large = buildJpegWithSof0(200, 200, 9000); // ~0.225 bytes/pixel, still plausible
    const bytes = new Uint8Array([...small, 0x00, 0x00, ...large]);
    const span = findLargestJpegSpan(bytes);
    expect(span).not.toBeNull();
    expect(span!.end - span!.start).toBe(large.length);
  });

  test('accepts a span whose SOF cannot be parsed (no dimension check possible) rather than rejecting it outright', () => {
    // The pre-existing builder (no SOF0 marker at all) from the earlier
    // describe block — `jpegPixelCount` returns null for it, and the
    // filter must fall through to accepting it (preserves prior behaviour
    // for any JPEG variant this reader's minimal SOF scan doesn't handle).
    const bytes = new Uint8Array(buildFakeJpeg(new Array(5000).fill(0)));
    const span = findLargestJpegSpan(bytes);
    expect(span).toEqual({ start: 0, end: bytes.length });
  });
});
