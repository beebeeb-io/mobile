// @ts-nocheck — bun:test is outside the Expo tsconfig.
import { expect, test } from 'bun:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
function assertNoSecretLogging(source: string) {
  expect(source).not.toMatch(/(?:console\.[a-z]+|recordRuntimeTrace|(?:new\s+)?Error)\s*\([^;]*(?:\$\{[^}]*(?:token|kc|passphrase|wrapped)|,\s*(?:token|kc|passphrase|wrapped)\b)/i);
}
test('new_folder_link_sources_never_log_or_interpolate_secrets', () => {
  const files = ['src/lib/folder-link-create.ts', 'src/lib/folder-activity.ts'];
  const dir = 'src/components/folder-share';
  if (existsSync(dir)) files.push(...readdirSync(dir).filter(f => f.endsWith('.tsx') && !f.includes('.test.')).map(f => join(dir, f)));
  for (const file of files) { if (file.endsWith('folder-activity.ts') && !existsSync(file)) continue; assertNoSecretLogging(readFileSync(file, 'utf8')); }
});
test('the_guard_rejects_a_secret_logging_mutation', () => {
  expect(() => assertNoSecretLogging('console.info(`value ${token}`)')).toThrow();
  expect(() => assertNoSecretLogging('throw new Error(`value ${passphrase}`)')).toThrow();
});
