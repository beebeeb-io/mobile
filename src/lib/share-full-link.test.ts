// @ts-nocheck
/**
 * Task 1690 — every produced/copyable share string is ONE full link.
 *
 * Guus, 2026-10-02: "Met delen voortaan altijd full link, er staat nu dat het
 * los is maar is eigenlijk alsnog 1 geheel. Maak er gewoon 1 geheel van."
 *
 * buildFullShareLink() is the single builder every share string in the share
 * sheet goes through (the on-screen box, the Copy button, and the system
 * share via displayUrl). The #key= fragment semantics are pinned by task 1531
 * (base64url, encodeURIComponent, the fragment is never stripped) — these
 * tests pin the same invariants for the builder the sheet now uses.
 * Mutation-checked 2026-10-02: with the fragment dropped from the builder the
 * file fails 0 pass / 5 fail; restored it passes 5/5 (see task 1690 Notes).
 */
import { describe, expect, test } from 'bun:test';
import { buildFullShareLink } from './share-full-link';

const ORIGIN = 'https://app.beebeeb.io';

describe('buildFullShareLink — always embeds the key as #key= (1690)', () => {
  test('a base64url key lands in the fragment verbatim (no double encoding)', () => {
    const url = buildFullShareLink(ORIGIN, 'AbCdEf123-_Token', 'ESIzRFVmd4iZqrvM3e7_ECEyQ1RldoeYqbrL3O3-DyA');
    expect(url).toBe('https://app.beebeeb.io/s/AbCdEf123-_Token#key=ESIzRFVmd4iZqrvM3e7_ECEyQ1RldoeYqbrL3O3-DyA');
    expect(url).toContain('#key=');
  });

  test('a standard-base64 key (+ / =) is percent-encoded, never corrupted', () => {
    const url = buildFullShareLink(ORIGIN, 'token1', 'ESIzRFVmd4iZqrvM3e7/ECEyQ1RldoeYqbrL3O3+DyA=');
    expect(url).toBe(
      `https://app.beebeeb.io/s/token1#key=${encodeURIComponent('ESIzRFVmd4iZqrvM3e7/ECEyQ1RldoeYqbrL3O3+DyA=')}`,
    );
    // The '+' must be escaped — a bare '+' in a fragment is a valid-but-ambiguous paste.
    expect(url).not.toContain('+');
    expect(url).toContain('%2B');
    expect(url).toContain('#key=');
  });

  test('the fragment is the last part of the URL — nothing strips or appends after it', () => {
    const url = buildFullShareLink(ORIGIN, 'token2', 'key');
    expect(url.startsWith(`${ORIGIN}/s/token2#key=`)).toBe(true);
    expect(url.endsWith(encodeURIComponent('key'))).toBe(true);
  });

  test('a trailing slash on the base URL never doubles up before /s/', () => {
    expect(buildFullShareLink('https://app.beebeeb.io/', 't', 'k')).toBe('https://app.beebeeb.io/s/t#key=k');
  });

  test('localhost dev origins work the same way (localShareUrl parity with web dev)', () => {
    const url = buildFullShareLink('http://localhost:5173', 'abc', 'xyz');
    expect(url).toBe('http://localhost:5173/s/abc#key=xyz');
  });
});
