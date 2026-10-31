// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig.
//
// Files-app uploads crawled at ~2.5–3 MB/s: the File Provider extension
// hardcoded 1 MiB chunks — below the core's own 4 MiB ladder minimum — so a
// 500 MB file took 478 requests, each paying a full round trip. And with no
// retry, one dropped chunk request failed the whole upload and Files
// restarted it from the first byte. Measured on the simulator (500 MB):
// 1 MiB sequential 2.5–3 MB/s; 4 MiB sequential 6.2 MB/s, 0 failures;
// 4 MiB with two PUTs in flight left 2 of 77 requests unanswered by the
// server, so chunks stay one at a time. Rules pinned against the source:
//   1. The chunk size comes from the core ladder (`planChunks`, "mobile"),
//      capped for the extension's ~50 MB memory budget; never a literal.
//   2. Chunks are read, encrypted and PUT one at a time.
//   3. Each chunk PUT retries a timeout / dropped connection / 429 / 5xx with
//      backoff, and fails at once on anything else.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXTENSION = join(import.meta.dir, '..', '..', 'targets/file-provider/FileProviderExtension.swift');
const source = readFileSync(EXTENSION, 'utf-8');

function staticFunctionBody(name: string): string {
  const start = source.indexOf(`private static func ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('\n  /// ', start + 1);
  const nextFunc = source.indexOf('\n  private static func ', start + 1);
  const ends = [next, nextFunc].filter((i) => i > -1);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

describe('File Provider upload throughput', () => {
  const upload = staticFunctionBody('streamUpload');

  test('rule 1: chunk size is planned by the core and capped for the extension memory budget', () => {
    expect(/planChunks\(fileSizeBytes:\s*UInt64\(fileSize\),\s*profile:\s*"mobile"\)/.test(upload)).toBe(true);
    expect(/min\(\s*Int\(plan\.chunkSizeBytes\),\s*Self\.uploadChunkSizeCapBytes\s*\)/.test(upload)).toBe(true);
    expect(/static let uploadChunkSizeCapBytes = 4 \* 1024 \* 1024/.test(source)).toBe(true);
    expect(/1 \* 1024 \* 1024/.test(source)).toBe(false);
  });

  test('rule 2: chunks go up one at a time', () => {
    expect(/TaskGroup|addTask|async let/.test(upload)).toBe(false);
    const read = upload.indexOf('handle.read(upToCount: chunkSize)');
    const put = upload.indexOf('try await uploadChunkWithRetry(');
    expect(read).toBeGreaterThan(-1);
    expect(put).toBeGreaterThan(read);
    // The raw PUT is only reached through the retry wrapper.
    expect(/ApiClient\.shared\.uploadChunkV2\(/.test(upload)).toBe(false);
  });

  test('rule 3: a chunk PUT retries transient failures and fails fast on the rest', () => {
    expect(/static let maxAttemptsPerChunk = 4\b/.test(source)).toBe(true);
    const retry = staticFunctionBody('uploadChunkWithRetry');
    expect(/ApiClient\.shared\.uploadChunkV2\(/.test(retry)).toBe(true);
    expect(/guard attempt < Self\.maxAttemptsPerChunk, isRetryableChunkError\(error\) else \{ throw error \}/.test(retry)).toBe(true);
    expect(/Task\.sleep/.test(retry)).toBe(true);
    const retryable = staticFunctionBody('isRetryableChunkError');
    expect(/status == 429 \|\| status >= 500/.test(retryable)).toBe(true);
    expect(/urlError\.code != \.cancelled/.test(retryable)).toBe(true);
    expect(/return false\s*\}\s*$/.test(retryable.trimEnd())).toBe(true);
  });
});
