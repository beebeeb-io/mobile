// @ts-nocheck — bun runs this; source-shape guard for the native File Provider.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ENUMERATOR = join(ROOT, 'targets', 'file-provider', 'FileProviderEnumerator.swift');
const SYNC_ENGINE = join(ROOT, 'targets', 'file-provider', 'SyncEngine.swift');

function bracedBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated body for ${signature}`);
}

describe('iOS File Provider initial enumeration refresh', () => {
  test('an empty cached listing triggers a foreground refresh before finishEnumerating', () => {
    const src = readFileSync(ENUMERATOR, 'utf8');
    const body = bracedBody(src, 'func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage)');

    const emptyCheck = body.indexOf('if rows.isEmpty');
    expect(emptyCheck).toBeGreaterThanOrEqual(0);

    const refresh = body.indexOf('await SyncEngine.refreshContainer(containerId: containerId)', emptyCheck);
    expect(refresh).toBeGreaterThan(emptyCheck);

    const reread = body.indexOf('CacheManager.shared.children(parent: parent)', refresh);
    expect(reread).toBeGreaterThan(refresh);

    const finish = body.indexOf('observer.finishEnumerating(upTo: nil)', reread);
    expect(finish).toBeGreaterThan(reread);
  });

  test('extension refresh signals the Beebeeb domain manager, not the process default manager', () => {
    const src = readFileSync(SYNC_ENGINE, 'utf8');
    expect(src).not.toContain('NSFileProviderManager.default.signalEnumerator');
    expect(src).toContain('NSFileProviderManager(for: BeebeebConstants.fileProviderDomain)');
  });
});
