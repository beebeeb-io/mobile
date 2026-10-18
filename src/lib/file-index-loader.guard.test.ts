// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// Task 1959 — source guard: GET /files/index goes through file-index-loader.ts
// only. Before 1959 six modules called getFileIndex() directly, each with its
// own trigger and none coalesced; one of them (the backup reconcile, reached
// from SettingsScreen once per backed-up item) produced 18 whole-vault walks
// in 10 minutes. A new direct caller would bypass the in-flight dedupe and the
// revalidation window.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');
const ALLOWED = new Set(['lib/api.ts', 'lib/file-index-loader.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('file-index-loader source guard (task 1959)', () => {
  test('no module outside file-index-loader.ts uses getFileIndex', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(100); // the walk really saw src/
    const offenders = files
      .map((path) => relative(SRC, path))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => /\bgetFileIndex\b/.test(stripComments(readFileSync(join(SRC, rel), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  test('the loader itself still uses it (the guard is looking at real code)', () => {
    const loader = stripComments(readFileSync(join(SRC, 'lib/file-index-loader.ts'), 'utf8'));
    expect(/\bgetFileIndex\(/.test(loader)).toBe(true);
  });
});
