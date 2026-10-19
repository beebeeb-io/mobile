// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * Task 2050 (Guus, 2026-10-19) — source guard: storage location is shown and
 * chosen by COUNTRY. Cities together identify the hosting provider, so no
 * user-facing string in the app may name one (docs/canon/data-residency.md).
 *
 * What is scanned: every non-test source file in `src/` (.ts/.tsx) and every
 * native UI-bearing file (Swift, Kotlin, Java, plist, strings, xml, app.json)
 * outside the generated trees (Pods, build outputs, vendored xcframework and
 * the UniFFI bindings). Comments may explain the rule and are stripped first.
 * IANA timezone identifiers ('Europe/Helsinki') are machine data, not copy,
 * and are removed before matching.
 *
 * Test files are not scanned: the old-server contract tests must feed a
 * datacenter payload that still carries a city, to prove it is never rendered.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

// Case-insensitive for the unambiguous names; "Ede" only as the capitalised
// word (a place name), so "needed" or "ede" inside an identifier never trips it.
const CITY = /falkenstein|helsinki|nuremberg|n(?:ü|ue|u)rnberg|\bEde\b/i;
const EDE_PLACE = /\bEde\b/;
const IANA_ID = /\b[A-Z][A-Za-z_]+\/(?:Helsinki|Berlin|Amsterdam)\b/g;

const SKIP_DIRS = new Set([
  'node_modules', 'Pods', 'build', 'DerivedData', '.git', 'BeebeebCore.xcframework',
  '.gradle', 'intermediates', 'outputs',
]);
const SKIP_FILES = new Set(['beebeeb_uniffi.swift', 'beebeeb_uniffiFFI.h']);

function walk(dir: string, rx: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name) || SKIP_FILES.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, rx, out);
    else if (rx.test(name)) out.push(p);
  }
  return out;
}

/** Source with block comments and line comments removed (URLs survive). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

export function cityHits(src: string): string[] {
  const code = stripComments(src).replace(IANA_ID, '');
  const hits: string[] = [];
  code.split('\n').forEach((line, i) => {
    const m = line.match(CITY);
    if (!m) return;
    if (m[0].toLowerCase() === 'ede' && !EDE_PLACE.test(line)) return;
    hits.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

const SRC_FILES = walk(join(ROOT, 'src'), /\.(ts|tsx)$/).filter((f) => !/\.test\.(ts|tsx)$/.test(f));
const NATIVE_RX = /\.(swift|kt|java|plist|strings|xml|json)$/;
const NATIVE_FILES = [
  ...walk(join(ROOT, 'modules'), NATIVE_RX),
  ...walk(join(ROOT, 'ios', 'Beebeeb'), NATIVE_RX),
  ...walk(join(ROOT, 'ios', 'BeebeebShare'), NATIVE_RX),
  ...walk(join(ROOT, 'ios', 'BeebeebWidget'), NATIVE_RX),
  ...walk(join(ROOT, 'targets'), NATIVE_RX),
  ...walk(join(ROOT, 'plugins'), /\.(js|swift|kt)$/),
  ...walk(join(ROOT, 'android', 'app', 'src'), NATIVE_RX),
  ...['app.json'].map((f) => join(ROOT, f)).filter(existsSync),
].filter((f) => !/\.(test|spec)\./.test(f) && !/package(-lock)?\.json$/.test(f));

function offenders(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    for (const hit of cityHits(readFileSync(file, 'utf8'))) {
      out.push(`${relative(ROOT, file)}:${hit}`);
    }
  }
  return out;
}

describe('the guard itself (task 2050)', () => {
  test('flags a city in a string, a template, JSX text and a Swift string', () => {
    expect(cityHits(`const a = 'Stored in Falkenstein'`)).toHaveLength(1);
    expect(cityHits('const b = `Uploading to ${x} Helsinki`')).toHaveLength(1);
    expect(cityHits('<Text>Nürnberg, Germany</Text>')).toHaveLength(1);
    expect(cityHits('<Text>Nuremberg</Text>')).toHaveLength(1);
    expect(cityHits(`const region = 'Ede'`)).toHaveLength(1);
    expect(cityHits('let s = "Stored in Falkenstein"')).toHaveLength(1);
  });

  test('ignores comments, timezone identifiers and words that merely contain "ede"', () => {
    expect(cityHits('// Falkenstein is a comment')).toHaveLength(0);
    expect(cityHits('/* Helsinki */ const a = 1')).toHaveLength(0);
    expect(cityHits('{/* Nuremberg */}')).toHaveLength(0);
    expect(cityHits(`const tz = 'Europe/Helsinki'`)).toHaveLength(0);
    expect(cityHits('const needed = precede')).toHaveLength(0);
    expect(cityHits(`const u = 'https://example.com/a'`)).toHaveLength(0);
  });
});

describe('no city name in any user-facing string (task 2050)', () => {
  test('the walks found the source trees (a guard that scans nothing is red)', () => {
    expect(SRC_FILES.length).toBeGreaterThan(100);
    expect(NATIVE_FILES.length).toBeGreaterThan(10);
  });

  test('src/ (non-test source) names no city', () => {
    expect(offenders(SRC_FILES)).toEqual([]);
  });

  test('native UI sources (Swift, Kotlin, plist, strings, app.json) name no city', () => {
    expect(offenders(NATIVE_FILES)).toEqual([]);
  });
});
