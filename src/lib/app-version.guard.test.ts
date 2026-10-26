// @ts-nocheck
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
function violations(source) {
  return /expoConfig\s*(?:\?\.)?\s*\.?\s*version\b|['"]1\.0\.0['"]/.test(source);
}
function scan(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return scan(path);
    if (!/\.[jt]sx?$/.test(entry.name) || /\.test\./.test(entry.name) || entry.name === 'app-version.ts') return [];
    return violations(readFileSync(path, 'utf8')) ? [relative(root, path)] : [];
  });
}
test('every production src version reader uses the single app-version helper', () => {
  expect(scan(root)).toEqual([]);
});
test('guard detects both regressed config reads and static version literals', () => {
  for (const source of ['Constants.expoConfig?.version', 'Constants.expoConfig.version', "const version = '1.0.0'", 'const version = "1.0.0"']) expect(violations(source)).toBe(true);
  expect(violations('appVersion().version')).toBe(false);
});
