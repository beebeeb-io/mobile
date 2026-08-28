#!/usr/bin/env bun
/**
 * Per-file isolated test runner (task 0877).
 *
 * Why this exists: bun 1.3.4 registers `mock.module()` on a PROCESS-GLOBAL registry that is
 * never reset between test files, and `mock.restore()` does not undo it. The first file to
 * register a specifier wins for the whole run, so two files mocking the same module
 * differently corrupt each other. Concretely: `api-client-session.test.ts` registers
 * `mock.module('expo-file-system', () => ({}))` (empty), which starves `welcome-seed.test.ts`
 * of `cacheDirectory` and makes it skip seeding -> 10 phantom failures in the full suite that
 * all pass when their file is run alone.
 *
 * Jest solves this by giving every test file its own module registry. bun has no such flag,
 * so we get the same semantics the only way available: one `bun test` process per file.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SEARCH_DIRS = ['src', '__tests__', 'app'];
const CONCURRENCY = 6;

function collectTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTestFiles(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((d) => collectTestFiles(join(ROOT, d))).sort();

if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

// NODE_OPTIONS is stripped: a stale cmux `restore-node-options.cjs` preload crashes node/bun.
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;

async function runFile(file) {
  const proc = Bun.spawn(['bun', 'test', file], {
    cwd: ROOT,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = stdout + stderr;
  const pass = Number(output.match(/^\s*(\d+) pass$/m)?.[1] ?? 0);
  const fail = Number(output.match(/^\s*(\d+) fail$/m)?.[1] ?? 0);
  return { file: relative(ROOT, file), pass, fail, exitCode, output };
}

const results = [];
let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const result = await runFile(file);
      results.push(result);
      const mark = result.fail === 0 && result.exitCode === 0 ? 'ok  ' : 'FAIL';
      console.log(`${mark} ${result.file}  (${result.pass} pass, ${result.fail} fail)`);
    }
  }),
);

const broken = results.filter((r) => r.fail > 0 || r.exitCode !== 0);
for (const r of broken) {
  console.log(`\n${'='.repeat(70)}\n${r.file}\n${'='.repeat(70)}\n${r.output}`);
}

const totalPass = results.reduce((n, r) => n + r.pass, 0);
const totalFail = results.reduce((n, r) => n + r.fail, 0);
console.log(
  `\nisolated: ${totalPass} pass, ${totalFail} fail across ${results.length} files` +
    (broken.length ? ` — ${broken.length} file(s) failing` : ''),
);
process.exit(broken.length ? 1 : 0);
