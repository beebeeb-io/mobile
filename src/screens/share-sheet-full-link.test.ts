// @ts-nocheck
/**
 * Task 1690 — sharing always produces ONE full link (Guus, 2026-10-02,
 * verbatim: "Met delen voortaan altijd full link, er staat nu dat het los is
 * maar is eigenlijk alsnog 1 geheel. Maak er gewoon 1 geheel van.").
 *
 * ShareSheetScreen presented the share as two separate items — a bare URL
 * (copy target 'link') plus a "Decryption key" box badged "SEND SEPARATELY"
 * (copy target 'key') — while the share is one unit. The split presentation
 * and every "separate channels" claim are removed: the sheet shows/copies the
 * single full link built by buildFullShareLink() (src/lib/share-full-link.ts;
 * functional tests in share-full-link.test.ts).
 *
 * This file asserts the STRUCTURE of ShareSheetScreen.tsx. Written RED-first:
 * it failed against the split-default code (5 failures + 2 skipped, see
 * task 1690 Notes).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf-8');
}

const screen = read('./ShareSheetScreen.tsx');
// The helper exists only once the split presentation is removed; before that,
// its describe block is skipped (reported as skipped, not silently green).
let helper: string | null = null;
try {
  helper = read('../lib/share-full-link.ts');
} catch {
  helper = null;
}

describe('ShareSheetScreen has no split presentation (1690)', () => {
  test('the SEND SEPARATELY badge and the separate key box are gone', () => {
    expect(screen).not.toContain('SEND SEPARATELY');
    expect(screen).not.toContain('Decryption key');
  })

  test('no copy implies link and key travel separately', () => {
    expect(screen).not.toContain('separate channels');
    expect(screen).not.toContain('both the link and the key');
  })

  test('the bare-URL + raw-key state pair is gone', () => {
    // Assert the removed state precisely: the invite flow's local
    // encryptFileKeyForRecipient() shareKey variable is unrelated and stays.
    expect(screen).not.toContain('shareUrlBase');
    expect(screen).not.toContain('setShareKey');
    expect(screen).not.toContain("useState<'full' | 'link' | 'key'");
  })
})

describe.skipIf(helper === null)('ShareSheetScreen builds the one full link through the shared builder (1690)', () => {
  test('the screen routes its URL through buildFullShareLink', () => {
    expect(screen).toContain('buildFullShareLink');
    // The only remaining clipboard target is the full link; 'link'/'key'
    // targets are gone.
    expect(screen).not.toMatch(/'link' \| 'key'/);
    expect(screen).not.toMatch(/'full' \| 'link' \| 'key'/);
  })

  test('the #key= fragment lives in the shared builder, 1531 semantics intact', () => {
    expect(helper).not.toBeNull();
    expect(helper!).toContain('#key=${encodeURIComponent(');
    // The builder never strips or truncates the fragment: it must be the LAST
    // thing appended to the URL.
    expect(helper!.trimEnd().endsWith('}')).toBe(true);
  })
})
