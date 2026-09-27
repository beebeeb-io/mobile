/**
 * raw-preview — PURE core of the camera-RAW preview feature (task 1569):
 * finding the largest embedded JPEG in a RAW file's bytes, and reading its
 * own minimal TIFF/EXIF tags (Make/Model/LensModel/ISO/ExposureTime/
 * FNumber/FocalLength) for the Info sheet.
 *
 * Kept dependency-free (no `expo-file-system`, no `react-native`, no
 * third-party parsing library) SPECIFICALLY so this file stays importable
 * under this project's test runner (`bun test`) — confirmed the hard way:
 * an earlier version of this module imported `expo-file-system/legacy` at
 * the top (needed by the impure "read the file, write the extracted
 * preview" glue), and just IMPORTING that for the pure-function tests
 * segfaulted bun outright (`panic(main thread): Segmentation fault`,
 * reproduced identically importing this codebase's own `transfer-api.ts`,
 * which pulls in `react-native` transitively — the same class of problem
 * `audio-format.ts`'s own doc comment already flags for `PreviewScreen.tsx`
 * itself, just one import hop further than expected). The impure
 * filesystem glue that actually extracts a preview from a decrypted temp
 * file lives in `raw-extract.ts`, which imports FROM this file, never the
 * other way round.
 *
 * **Route considered and set aside #1: iOS ImageIO / CGImageSource.** The
 * brief's preferred approach — a small native module calling
 * `CGImageSourceCreateThumbnailAtIndex` — was the first thing tried, via
 * `exifr` (already a web dependency doing the same job,
 * `repos/web/src/components/preview/raw-preview.tsx`) as a fast way to
 * validate the APPROACH before committing to native Swift. That validation
 * surfaced a real problem with the "just call the library" version of the
 * plan: run against all 6 of this task's real fixtures
 * (`e2e/fixtures/preview-matrix/raw/`), `exifr.thumbnail()` only returned a
 * usable image for 2 of 6 (CR2: 8KB, ARW: 8.9KB — both a tiny legacy IFD1
 * thumbnail, not a real preview) and threw "Unknown file format" outright
 * for CR3 and RAF (their container formats — ISO-BMFF and a proprietary
 * TIFF-at-an-offset layout respectively — aren't ones `exifr`'s format
 * sniffer recognizes as a top-level file at all). NEF and DNG parsed EXIF
 * fine but returned `null` thumbnails (their preview lives in a `SubIFDs`
 * entry, not the classic IFD1 thumbnail tags `exifr.thumbnail()` reads).
 *
 * **Route considered and set aside #2: `exifr` itself, for the EXIF half.**
 * `exifr`'s EXIF parsing (as opposed to its thumbnail extraction, ruled out
 * above) DID produce correct tags for CR2/ARW/NEF/DNG. It was dropped
 * anyway after it broke the Release build outright: `exifr`'s only
 * RN-resolvable build (`dist/full.umd.js`, via the package's `main` field —
 * `mini`/`lite` exist but don't recognize ANY camera RAW format at all,
 * confirmed by running them against all 4 TIFF-based fixtures) contains an
 * internal `import(/* webpackIgnore *\/ e)` used for its own lazy segment
 * loading. Metro cannot statically rewrite a dynamic `import()` whose
 * specifier is a variable (only literal-string specifiers are), so it
 * reaches Hermes' bytecode compiler as a literal runtime `import()`
 * expression — which Hermes does not support at all — and the Release
 * build failed at the "Bundle React Native code" step with `error: Invalid
 * expression encountered` pointing straight at that line, regardless of
 * which `exifr.parse()` options were passed (the option flags only affect
 * runtime behavior; Hermes fails at COMPILE time on the mere presence of
 * the expression in the bundle). Confirmed together with Guus's own bar for
 * this build ("100% sure it works") that a broken Release build is worse
 * than a smaller, self-written parser — see the hand-rolled
 * `parseTiffExifTags`/`findJpegExifTiffOffset` below, which reproduce
 * `exifr`'s exact output for all 4 TIFF-based fixtures (verified
 * side-by-side before the swap) with zero third-party bundle risk.
 *
 * **What actually works for the PREVIEW image, verified against all 6 real
 * fixtures:** every one of them embeds at least one FULL-SIZE JFIF JPEG
 * preview somewhere in its byte stream (this is exactly how Photos.app/
 * Preview.app/QuickLook show a RAW thumbnail without decoding raw sensor
 * data) — scanning for the largest complete JPEG (SOI…EOI) span found one
 * in every fixture, independently confirmed valid via macOS `sips` (never
 * trust your own scanner alone): CR2 1944×1296, CR3 3408×2272, ARW
 * 1616×1080, NEF 570×375, RAF 1280×960, DNG 3960×2640 — all real, in-focus,
 * correctly-oriented photos, not noise. This is format-agnostic (no
 * per-vendor container parser is needed for CR3/RAF) and gives a
 * dramatically better preview than `exifr.thumbnail()`'s IFD1 thumb even
 * for the 2 formats it did support. `findLargestJpegSpan` below is that
 * scanner.
 *
 * **EXIF, verified against all 6 real fixtures:** `parseTiffExifTags` reads
 * the RAW container's own TIFF header directly — works for CR2/ARW/NEF/DNG
 * (all four are TIFF-based at byte 0). CR3's ISO-BMFF box container and
 * RAF's proprietary layout aren't TIFF at the top level, so this returns
 * `null` for those — `findJpegExifTiffOffset` + a second `parseTiffExifTags`
 * call against the EXTRACTED preview JPEG's own APP1 Exif segment recovers
 * real tags for RAF (confirmed: its embedded preview carries a full, correct
 * EXIF block). CR3's embedded preview carries no Exif segment either in the
 * one sample checked — an honest, documented gap for that one format, not
 * silently retried forever or faked.
 */

export interface RawExifInfo {
  cameraModel: string | null;
  lensModel: string | null;
  iso: string | null;
  shutterSpeed: string | null;
  aperture: string | null;
  focalLength: string | null;
}

export interface JpegSpan {
  /** Byte offset of the span's leading 0xFFD8 (SOI). */
  start: number;
  /** Byte offset one past the span's trailing 0xFFD9 (EOI) — i.e. exclusive,
   * so `bytes.subarray(start, end)` is the complete JPEG. */
  end: number;
}

/** Below this size, a found SOI…EOI span is treated as an incidental byte
 * coincidence in raw sensor data rather than a genuine embedded preview —
 * every real fixture's largest span is well over 100KB, so this has wide
 * margin without risking a false negative on a real (if small) preview. */
export const MIN_EMBEDDED_JPEG_BYTES = 4096;

/**
 * Scans arbitrary bytes for every complete JFIF-style JPEG (SOI 0xFFD8 …
 * EOI 0xFFD9) span, walking each marker segment's own declared length so
 * that entropy-coded scan data — which routinely contains incidental
 * 0xFF-led byte pairs — never truncates a span early. A naive
 * `indexOf(0xFFD9)` does exactly that: it would stop at the FIRST 0xFF 0xD9
 * byte pair anywhere after the SOI, which for a multi-megabyte JPEG is
 * almost always well before the real end. This walks the actual marker
 * structure instead: ordinary segments are skipped by their own two-byte
 * big-endian length; the SOS (Start Of Scan) segment's entropy-coded data
 * has no declared length, so scanning resumes byte-by-byte until the next
 * genuine marker (a literal 0xFF in scan data is always "stuffed" as
 * 0xFF 0x00 by any correct encoder, or is an RSTn restart marker — neither
 * of those, nor a fill byte, terminates the scan; only a marker with a
 * real payload code does).
 */
export function findJpegSpans(bytes: Uint8Array): JpegSpan[] {
  const spans: JpegSpan[] = [];
  const len = bytes.length;
  let i = 0;
  while (i < len - 2) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      const end = scanForEoi(bytes, i + 2);
      if (end !== null) {
        spans.push({ start: i, end });
        i = end;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/**
 * Walks marker segments starting at a byte index known to hold 0xFF (the
 * third byte of an already-matched SOI), returning the index just past the
 * terminating EOI, or `null` if the buffer ends first (a truncated/corrupt
 * candidate — the caller's outer scan just advances one byte and keeps
 * looking, which is safe: JPEG markers are byte-aligned two-byte codes, so
 * a genuine JPEG will not be found starting one byte later either).
 */
function scanForEoi(bytes: Uint8Array, from: number): number | null {
  const len = bytes.length;
  let k = from;
  while (k < len - 1) {
    if (bytes[k] !== 0xff) {
      k++;
      continue;
    }
    const marker = bytes[k + 1];
    if (marker === 0xd9) return k + 2; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // TEM / RSTn restart markers carry no payload.
      k += 2;
      continue;
    }
    if (marker === 0xff) {
      // Fill byte before the real marker code — re-check at k+1.
      k++;
      continue;
    }
    if (marker === 0xda) {
      // SOS: a normal length-prefixed header, then raw entropy-coded scan
      // data with NO declared length — resume byte-by-byte until the next
      // marker that isn't a stuffed 0xFF00 or an RSTn restart marker.
      if (k + 4 > len) return null;
      const segLen = (bytes[k + 2]! << 8) | bytes[k + 3]!;
      k = k + 2 + segLen;
      while (k < len - 1) {
        if (bytes[k] === 0xff && bytes[k + 1] !== 0x00 && !(bytes[k + 1] >= 0xd0 && bytes[k + 1] <= 0xd7)) {
          break;
        }
        k++;
      }
      continue;
    }
    // Generic marker segment: 2-byte big-endian length, INCLUDING itself.
    if (k + 4 > len) return null;
    const segLen = (bytes[k + 2]! << 8) | bytes[k + 3]!;
    if (segLen < 2) return null; // malformed — bail, caller advances past this candidate
    k += 2 + segLen;
  }
  return null;
}

/**
 * The largest complete JPEG span in `bytes` at or above
 * `MIN_EMBEDDED_JPEG_BYTES`, or `null` if none qualifies (a genuinely
 * corrupt/unsupported file — the caller shows the honest fallback card).
 * "Largest" is deliberate, not just "first": RAW files can embed several
 * previews at different sizes (this task's DNG fixture had 43 distinct
 * spans), and the largest is reliably the full-size preview rather than a
 * small secondary thumbnail.
 */
/**
 * Above this ratio, a candidate span is treated as an implausible JPEG and
 * skipped rather than trusted. Real embedded camera previews across all six
 * of this task's fixtures measured 0.05–0.83 bytes/pixel; 1.0 leaves wide
 * margin above the highest real one while still catching the false-positive
 * class this constant exists for (see `jpegPixelCount`'s doc comment).
 */
const MAX_PLAUSIBLE_JPEG_BYTES_PER_PIXEL = 1.0;

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

/**
 * Reads the pixel count (width × height) a JPEG span's own Start-Of-Frame
 * marker (SOF0-SOF15, excluding DHT/JPG/DAC which reuse marker codes in
 * that range) declares, or `null` if none is found/parseable before the
 * span's own end. Used by `findLargestJpegSpan` to reject spans whose
 * claimed dimensions don't match their byte size plausibly — see that
 * function's doc comment for why this check exists at all.
 */
function jpegPixelCount(bytes: Uint8Array, span: JpegSpan): number | null {
  let i = span.start + 2; // skip the SOI this span starts with
  const end = span.end;
  while (i < end - 1) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (i + 4 > end) return null;
    const segLen = readUint16BE(bytes, i + 2);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (i + 9 > end) return null;
      const height = readUint16BE(bytes, i + 5);
      const width = readUint16BE(bytes, i + 7);
      return width * height > 0 ? width * height : null;
    }
    if (marker === 0xda) return null; // hit scan data without ever finding a SOF
    if (segLen < 2) return null;
    i += 2 + segLen;
  }
  return null;
}

/**
 * The largest complete JPEG span in `bytes` at or above
 * `MIN_EMBEDDED_JPEG_BYTES` whose own declared dimensions are plausible for
 * its byte size, or `null` if none qualifies (a genuinely corrupt/
 * unsupported file — the caller shows the honest fallback card).
 *
 * "Largest wins" alone is NOT enough: verified on a real fixture (this
 * task's `sample.cr2`) — the RAW sensor data that follows the real embedded
 * preview in the file can, purely by byte-pattern coincidence, contain a
 * span that LOOKS like a complete, well-formed JPEG (valid SOI/markers/EOI)
 * and is LARGER than the genuine preview, but decodes (confirmed with both
 * Pillow and ImageMagick) to a flat, wrong, noise-banded image — not the
 * real photo. Its declared dimensions (1944×1296) against its byte count
 * (4.45MB) work out to 1.77 bytes/pixel; every genuine preview measured
 * across all 6 of this task's fixtures (including this same CR2's own real,
 * smaller, 366KB preview at 0.15 bytes/pixel) stayed under 0.84. Rejecting
 * implausibly-dense candidates and falling through to the next-largest one
 * fixes this without a real JPEG decoder — confirmed fixed on-device
 * (screenshots in this task's Notes) after being confirmed broken the same
 * way in Node/Bun first (this file's own `bun test` run cannot catch it: no
 * synthetic byte sequence reproduces "coincidentally shaped like a JPEG",
 * only a real RAW file's actual sensor data does).
 */
export function findLargestJpegSpan(bytes: Uint8Array): JpegSpan | null {
  const candidates = findJpegSpans(bytes)
    .map((span) => ({ span, size: span.end - span.start }))
    .filter(({ size }) => size >= MIN_EMBEDDED_JPEG_BYTES)
    .sort((a, b) => b.size - a.size);

  for (const { span, size } of candidates) {
    const pixels = jpegPixelCount(bytes, span);
    if (pixels != null && size / pixels > MAX_PLAUSIBLE_JPEG_BYTES_PER_PIXEL) {
      continue; // implausibly dense for its own declared dimensions — skip
    }
    return span;
  }
  return null;
}

/**
 * The FIRST read attempt's byte length, when scanning a RAW file for its
 * embedded preview (task 1569 P1 fix, Codex review on PRs #126/#127 — see
 * `scanForLargestJpegSpan`'s own doc comment for the bug this replaces).
 * Chosen from real measurement, not a guess: scanning all 6 of this task's
 * real fixtures (`e2e/fixtures/preview-matrix/raw/`, CR2/CR3/ARW/NEF/RAF/DNG)
 * for their own largest qualifying embedded-JPEG span found the span's own
 * trailing byte offset (i.e. how far into the file you must read to have
 * captured the WHOLE preview) at 7.0% / 27.6% / 14.3% / 3.6% / 7.2% / 33.4%
 * of each file's total size — every one comfortably inside a fixed 8MB for
 * these (2.4-6.9MB) fixtures, and the absolute end-offset (not just the
 * percentage) tops out at 1.45MB (CR3). Preview JPEG size scales with the
 * camera's OUTPUT resolution, not with total file size (which mostly grows
 * with raw sensor bit depth/compression) — a 45MP body's preview is larger
 * than these fixtures' but not proportionally to a 150MB RAW file, so 8MB
 * carries wide margin for real-world files this size too, not just these
 * exact samples.
 */
export const RAW_PREVIEW_SCAN_INITIAL_BYTES = 8 * 1024 * 1024;

/**
 * The hard ceiling `scanForLargestJpegSpan` will never read past, no matter
 * how large the file or how many growth steps it takes. This is the actual
 * fix for the P1 finding: regardless of a 50-150MB (or larger) camera RAW's
 * true size, this function will request at most this many bytes from disk —
 * bounding peak JS-heap usage to a small, fixed multiple of THIS constant
 * (base64 string + decoded binary string + Uint8Array), never of the file's
 * own size. Four steps of `RAW_PREVIEW_SCAN_GROWTH_FACTOR` (×4) growth from
 * the initial 8MB reaches this cap (8 -> 32 -> 128MB, so the cap below sits
 * between the 2nd and 3rd step) — wide margin above the ~1.5MB worst-case
 * real offset measured above for a layout this reader has never actually
 * seen, without ever approaching "read the whole file" territory again.
 */
export const RAW_PREVIEW_SCAN_MAX_BYTES = 32 * 1024 * 1024;

/** How much each retry multiplies the previous read length by, when the
 * previous (smaller) read found no qualifying preview. 4x reaches the cap in
 * one growth step from the initial 8MB (8MB -> 32MB) — this reader is a
 * safety net for a RAW layout convention this task's 6 real fixtures never
 * exhibited (every one of them found its preview inside the FIRST read), not
 * a path expected to run often, so a fast ramp to the cap beats many small
 * steps that each cost a full re-read of everything read so far. */
const RAW_PREVIEW_SCAN_GROWTH_FACTOR = 4;

/** Reads up to `length` bytes from the start of the file being scanned.
 * Implemented by `raw-extract.ts` as a single bounded
 * `FileSystem.readAsStringAsync(uri, { encoding: Base64, position: 0, length
 * })` call, decoded to bytes — never a read of the whole file. */
export type BoundedByteReader = (length: number) => Promise<Uint8Array>;

/**
 * Drives `readBytes` with a geometrically growing length — starting at
 * `RAW_PREVIEW_SCAN_INITIAL_BYTES`, multiplying by `RAW_PREVIEW_SCAN_GROWTH_FACTOR`
 * on each retry, always clamped to both `capBytes` and `fileSizeBytes` —
 * stopping the instant `findLargestJpegSpan` finds a qualifying span in what
 * has been read so far, or once neither the cap nor the file's own size
 * allow reading any more. This is the fix for the P1 Codex finding on PRs
 * #126/#127: `raw-extract.ts`'s `readFileBytes` used to call
 * `FileSystem.readAsStringAsync` with NO `length` at all, base64-round-
 * tripping the entire RAW file — for an ordinary 50-150MB camera RAW, that
 * is several hundred MB of live JS-heap strings/arrays at once (the base64
 * string, `atob`'s decoded binary string, and the final `Uint8Array`, all
 * proportional to the FULL file size), which froze or crashed the preview.
 * This function instead bounds every single read to at most `capBytes`
 * (`RAW_PREVIEW_SCAN_MAX_BYTES` by default) regardless of how large the file
 * claims to be — verified by a dedicated unit test that never sees a
 * requested length exceed the cap even for a 500MB synthetic file that never
 * yields a qualifying span at all (the adversarial case: a naive "keep
 * growing until found" loop would otherwise march all the way up to the
 * full file size).
 *
 * Kept here (not in the impure `raw-extract.ts`) specifically so it stays
 * unit-testable with a mock `readBytes` — see this file's own top comment on
 * why importing `expo-file-system/legacy` at module scope segfaults `bun
 * test`; this function takes the read as a plain injected callback instead,
 * so it has no such import and no such problem.
 */
export async function scanForLargestJpegSpan(
  fileSizeBytes: number,
  readBytes: BoundedByteReader,
  capBytes: number = RAW_PREVIEW_SCAN_MAX_BYTES,
  initialBytes: number = RAW_PREVIEW_SCAN_INITIAL_BYTES,
): Promise<{ bytes: Uint8Array; span: JpegSpan | null }> {
  let length = Math.max(0, Math.min(initialBytes, fileSizeBytes, capBytes));
  let bytes: Uint8Array = new Uint8Array(0);
  for (;;) {
    bytes = length > 0 ? await readBytes(length) : new Uint8Array(0);
    const span = findLargestJpegSpan(bytes);
    if (span || length >= capBytes || length >= fileSizeBytes) {
      return { bytes, span };
    }
    length = Math.min(length * RAW_PREVIEW_SCAN_GROWTH_FACTOR, capBytes, fileSizeBytes);
  }
}

// ---------------------------------------------------------------------------
// Minimal TIFF/EXIF tag reader — see this file's top doc comment for why
// this exists instead of a third-party library (exifr's only RN-resolvable
// build broke the Hermes Release compile). Reads exactly the tags
// `mapExifToRawInfo` (below) needs: Make, Model, LensModel, ISOSpeedRatings,
// ExposureTime, FNumber, FocalLength — from IFD0 and, when present, the
// Exif sub-IFD it points to (tag 0x8769). No thumbnail/SubIFDs/GPS/maker-note
// handling — this is deliberately narrow, not a general TIFF library.
// ---------------------------------------------------------------------------

const TIFF_TYPE_SIZE_BYTES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL (2x LONG)
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL (2x SLONG)
  11: 4, // FLOAT
  12: 8, // DOUBLE
};

/** Tag id -> output key, for the tags this reader understands. 0x8769
 * (ExifIFD) is handled specially in `readIfd` (it recurses into the
 * pointed-to sub-IFD rather than being read as an ordinary value). */
const TIFF_TAG_NAMES: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x8769: 'ExifIFD',
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISO',
  0x920a: 'FocalLength',
  0xa434: 'LensModel',
};

function readUint16(bytes: Uint8Array, offset: number, little: boolean): number {
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  return little ? b0 | (b1 << 8) : (b0 << 8) | b1;
}

function readUint32(bytes: Uint8Array, offset: number, little: boolean): number {
  const b0 = bytes[offset]!;
  const b1 = bytes[offset + 1]!;
  const b2 = bytes[offset + 2]!;
  const b3 = bytes[offset + 3]!;
  return (little ? b0 | (b1 << 8) | (b2 << 16) | (b3 << 24) : (b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

function readAsciiValue(bytes: Uint8Array, offset: number, count: number): string {
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = bytes[offset + i];
    if (!c) break; // NUL-terminated, per the TIFF spec
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** Reads one IFD entry's value given its type/count and the offset of its
 * own 4-byte value/offset field (which either holds the value inline, when
 * it fits in 4 bytes, or an offset to it elsewhere in the buffer). Returns
 * `null` for anything out of bounds (a corrupt or adversarially-crafted
 * offset) rather than throwing — this reader must degrade to "no EXIF
 * shown", never crash the preview. Only ASCII/SHORT/LONG/RATIONAL are
 * implemented — the only types this task's six tags actually use. */
function readIfdEntryValue(
  bytes: Uint8Array,
  tiffBase: number,
  little: boolean,
  type: number,
  count: number,
  valueFieldOffset: number,
): string | number | null {
  const typeSize = TIFF_TYPE_SIZE_BYTES[type];
  if (!typeSize || count <= 0) return null;
  const totalBytes = typeSize * count;
  const dataOffset = totalBytes <= 4 ? valueFieldOffset : tiffBase + readUint32(bytes, valueFieldOffset, little);
  if (dataOffset < 0 || dataOffset + totalBytes > bytes.length) return null;

  if (type === 2) return readAsciiValue(bytes, dataOffset, count) || null; // ASCII
  if (type === 3) return readUint16(bytes, dataOffset, little); // SHORT (first value)
  if (type === 4) return readUint32(bytes, dataOffset, little); // LONG (first value)
  if (type === 5) {
    // RATIONAL: two LONGs, numerator then denominator.
    const numerator = readUint32(bytes, dataOffset, little);
    const denominator = readUint32(bytes, dataOffset + 4, little);
    return denominator !== 0 ? numerator / denominator : null;
  }
  return null;
}

/** Walks one IFD's entries, writing recognized tags into `out`. Recurses
 * (at most `depthRemaining` times — real EXIF only ever nests IFD0 -> Exif
 * sub-IFD, i.e. depth 1) when it finds the Exif sub-IFD pointer, so a
 * maliciously crafted cyclic offset can't recurse unboundedly. */
function readIfd(
  bytes: Uint8Array,
  tiffBase: number,
  little: boolean,
  ifdOffset: number,
  out: Record<string, string | number>,
  depthRemaining: number,
): void {
  if (ifdOffset < 0 || ifdOffset + 2 > bytes.length) return;
  const entryCount = readUint16(bytes, ifdOffset, little);
  let entryOffset = ifdOffset + 2;
  for (let i = 0; i < entryCount; i++) {
    if (entryOffset + 12 > bytes.length) break;
    const tag = readUint16(bytes, entryOffset, little);
    const type = readUint16(bytes, entryOffset + 2, little);
    const count = readUint32(bytes, entryOffset + 4, little);
    const valueFieldOffset = entryOffset + 8;
    const name = TIFF_TAG_NAMES[tag];
    if (name === 'ExifIFD') {
      if (depthRemaining > 0) {
        const subIfdOffset = readUint32(bytes, valueFieldOffset, little);
        readIfd(bytes, tiffBase, little, tiffBase + subIfdOffset, out, depthRemaining - 1);
      }
    } else if (name) {
      const value = readIfdEntryValue(bytes, tiffBase, little, type, count, valueFieldOffset);
      if (value !== null) out[name] = value;
    }
    entryOffset += 12;
  }
}

/**
 * Reads Make/Model/LensModel/ISO/ExposureTime/FNumber/FocalLength from a
 * TIFF-structured byte range (a raw TIFF file — CR2/ARW/NEF/DNG all start
 * with one at byte 0 — or an embedded Exif block inside a JPEG, via
 * `findJpegExifTiffOffset`'s returned offset). Returns `null` when
 * `startOffset` isn't a valid TIFF header (wrong signature/magic, or a
 * corrupt/truncated buffer) or when the IFD walk found none of the
 * recognized tags.
 */
export function parseTiffExifTags(bytes: Uint8Array, startOffset = 0): Record<string, string | number> | null {
  if (startOffset < 0 || startOffset + 8 > bytes.length) return null;
  const b0 = bytes[startOffset]!;
  const b1 = bytes[startOffset + 1]!;
  let little: boolean;
  if (b0 === 0x49 && b1 === 0x49) little = true; // "II" — little-endian
  else if (b0 === 0x4d && b1 === 0x4d) little = false; // "MM" — big-endian
  else return null;

  const magic = readUint16(bytes, startOffset + 2, little);
  if (magic !== 42) return null;

  const ifd0Offset = readUint32(bytes, startOffset + 4, little);
  const out: Record<string, string | number> = {};
  readIfd(bytes, startOffset, little, startOffset + ifd0Offset, out, 1);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Finds a JPEG's APP1 "Exif\0\0" segment and returns the byte offset where
 * the TIFF structure inside it begins (ready to hand to `parseTiffExifTags`
 * as `startOffset`), or `null` if the JPEG has no such segment. Only scans
 * the marker segments that precede SOS (Start Of Scan) — APP1/Exif always
 * appears there, never inside entropy-coded scan data.
 */
export function findJpegExifTiffOffset(bytes: Uint8Array): number | null {
  let i = 0;
  const len = bytes.length;
  while (i < len - 4) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    if (marker === 0xda) return null; // Start Of Scan — no more markers before it
    if (i + 4 > len) return null;
    const segLen = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker === 0xe1 && segLen >= 8) {
      const payloadOffset = i + 4;
      if (
        bytes[payloadOffset] === 0x45 && // 'E'
        bytes[payloadOffset + 1] === 0x78 && // 'x'
        bytes[payloadOffset + 2] === 0x69 && // 'i'
        bytes[payloadOffset + 3] === 0x66 && // 'f'
        bytes[payloadOffset + 4] === 0x00 &&
        bytes[payloadOffset + 5] === 0x00
      ) {
        return payloadOffset + 6;
      }
    }
    if (segLen < 2) return null;
    i += 2 + segLen;
  }
  return null;
}

function trimTrailingZero(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function formatShutterSpeed(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds >= 1) return `${trimTrailingZero(seconds)}s`;
  const denominator = Math.round(1 / seconds);
  return denominator > 1 ? `1/${denominator}s` : `${trimTrailingZero(seconds)}s`;
}

/**
 * Maps `exifr`'s raw tag object to the six fields the Info sheet shows
 * (camera model, lens, ISO, shutter speed, aperture, focal length). Returns
 * `null` when NONE of the six could be resolved, so the caller can skip
 * adding an empty "EXIF" section entirely rather than showing six blank
 * rows — matches the task's "where the EXIF has them" phrasing.
 */
export function mapExifToRawInfo(tags: Record<string, unknown> | null | undefined): RawExifInfo | null {
  if (!tags) return null;

  const make = typeof tags.Make === 'string' ? tags.Make.trim() : '';
  const model = typeof tags.Model === 'string' ? tags.Model.trim() : '';
  // Some cameras' Model already repeats the Make (e.g. "Canon EOS 40D") —
  // avoid "Canon Canon EOS 40D" by dropping Make when Model already starts
  // with it (case-insensitive).
  const cameraModel =
    make && model && model.toLowerCase().startsWith(make.toLowerCase())
      ? model
      : [make, model].filter(Boolean).join(' ').trim() || null;

  const lensRaw = typeof tags.LensModel === 'string' ? tags.LensModel.trim() : '';
  // Sony (and others) report an all-dashes placeholder ("----") when no
  // lens is recorded — treat that the same as absent, not as a real value.
  const lensModel = lensRaw && !/^-+$/.test(lensRaw) ? lensRaw : null;

  const iso = typeof tags.ISO === 'number' && tags.ISO > 0 ? `ISO ${Math.round(tags.ISO)}` : null;
  const shutterSpeed = formatShutterSpeed(typeof tags.ExposureTime === 'number' ? tags.ExposureTime : null);
  const aperture = typeof tags.FNumber === 'number' && tags.FNumber > 0 ? `f/${trimTrailingZero(tags.FNumber)}` : null;
  const focalLength =
    typeof tags.FocalLength === 'number' && tags.FocalLength > 0 ? `${trimTrailingZero(tags.FocalLength)}mm` : null;

  if (!cameraModel && !lensModel && !iso && !shutterSpeed && !aperture && !focalLength) return null;
  return { cameraModel: cameraModel || null, lensModel, iso, shutterSpeed, aperture, focalLength };
}

/** Pure base64 <-> bytes helpers, duplicated here (not imported from
 * `transfer-api.ts`) for two reasons: (1) that module pulls in
 * `react-native` transitively, which would break this file's bun-testability
 * — see this file's own top comment; (2) this codebase's established
 * per-module-helper convention anyway (see `InfoSheet.tsx`'s note on the
 * identical situation for `decodedMetadataName`). Both rely only on the
 * global `atob`/`btoa`, which this project's other modules
 * (`PreviewScreen.tsx`, `thumbnail.ts`, `crypto-context.tsx`, …) already
 * depend on being present at runtime. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // One character at a time — NOT `String.fromCharCode(...chunk)` (even
  // chunked). Found on-device (bb-ios27, Release): the spread-based chunked
  // version produced a JPEG whose HEADERS were intact (valid per `sips`/
  // `file`, correct reported dimensions) but whose entropy-coded body was
  // corrupted enough that neither `<Image>`'s full decode nor a real
  // decoder (Pillow) could read it — a real-file symptom no small
  // synthetic unit-test byte sequence happened to trigger. Matches this
  // codebase's own OTHER base64 encoders exactly (`transfer-api.ts`'s
  // `bytesToBase64`, `PreviewScreen.tsx`'s equivalents) — none of them
  // chunk+spread either, which in hindsight was the tell.
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
