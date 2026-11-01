// @ts-nocheck
/**
 * Task 2253 rounds 2 and 3 (mobile#254 / mobile#265 reviews): the screen
 * wiring the export-file-name and export-share-copy tests cannot reach.
 *
 *  - Preview Save checks for the share sheet BEFORE it decrypts and copies the
 *    original, and never answers "Saved to <path>" for a copy the `finally`
 *    removes a moment later;
 *  - the export name is the route / pager name when it is real (not a list
 *    placeholder), then the entry's own envelope, then the route envelope
 *    decrypted locally, and only then the network;
 *  - a legacy bare name that starts with `{` is a name, not ciphertext;
 *  - Save to Files takes only a plain extension (from the name or the mime
 *    type) into the preview-cache file URI.
 *
 * Each check runs on the real source (must pass) AND on an in-memory mutation
 * that undoes the fix (must fail).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const preview = readFileSync(join(import.meta.dir, 'PreviewScreen.tsx'), 'utf8');
const files = readFileSync(join(import.meta.dir, 'FilesScreen.tsx'), 'utf8');

/** The `{ ... }` body after `marker` (brace matched), `//` comments stripped. */
function body(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i).replace(/\/\/[^\n]*/g, '');
    }
  }
  throw new Error(`unbalanced after: ${marker}`);
}

function inOrder(hay: string, needles: string[]): boolean {
  let at = -1;
  for (const n of needles) {
    const next = hay.indexOf(n, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

function guarded(name: string, source: string, check: (s: string) => boolean, mutate: (s: string) => string) {
  test(name, () => {
    expect(check(source)).toBe(true);
    const mutated = mutate(source);
    expect(mutated).not.toBe(source);
    let mutatedPasses: boolean;
    try {
      mutatedPasses = check(mutated);
    } catch {
      mutatedPasses = false;
    }
    expect({ name, mutatedPasses }).toEqual({ name, mutatedPasses: false });
  });
}

const HANDLE_DOWNLOAD = 'const handleDownload = useCallback(async () => {';
const RESOLVE = 'const resolveExportDisplayName = useCallback(async (): Promise<string | null> => {';
const DECRYPT = 'const decryptExportName = useCallback(async (nameEncrypted: string | null | undefined): Promise<string | null> => {';

describe('Preview Save', () => {
  guarded(
    'checks for the share sheet before decrypting and copying, and never names the released copy',
    preview,
    (s) => {
      const b = body(s, HANDLE_DOWNLOAD);
      return (
        inOrder(b, [
          'if (!(await Sharing.isAvailableAsync())) {',
          "Alert.alert('Not available', 'Saving is not available on this device.');",
          'return;',
          'await getExportUri(',
          'await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);',
          'await Sharing.shareAsync(shareUri, {',
        ]) && !/Saved to/.test(b)
      );
    },
    // round 1's shape: decrypt and copy first, ask afterwards
    (s) => s.replace(
      "      if (!(await Sharing.isAvailableAsync())) {\n        Alert.alert('Not available', 'Saving is not available on this device.');\n        return;\n      }\n",
      '',
    ),
  );
  guarded(
    'the old "Saved to ${shareUri}" alert fails the check',
    preview,
    (s) => !/Saved to/.test(body(s, HANDLE_DOWNLOAD)),
    (s) => s.replace(
      "      await Sharing.shareAsync(shareUri, {\n        mimeType: currentMimeType ?? 'application/octet-stream',",
      "      Alert.alert('Downloaded', `Saved to ${shareUri}`);\n      await Sharing.shareAsync(shareUri, {\n        mimeType: currentMimeType ?? 'application/octet-stream',",
    ),
  );
});

describe('the export name', () => {
  const order = [
    'if (isExportableDisplayName(currentFileName)) return currentFileName;',
    'if (currentEntry?.name_encrypted) return decryptExportName(currentEntry.name_encrypted);',
    'const fromRoute = await decryptExportName(currentFileName);',
    'if (fromRoute) return fromRoute;',
    'await getFile(currentFileId);',
  ];
  guarded(
    'a real route / pager name first (already decrypted, with the right key), the network last',
    preview,
    (s) => inOrder(body(s, RESOLVE), order),
    // round 2's shape: the pager entry re-decrypted with the master key first
    (s) => s.replace(
      '    if (isExportableDisplayName(currentFileName)) return currentFileName;\n    // Swipe-pager entry: it carries the file\'s own encrypted name.\n    if (currentEntry?.name_encrypted) return decryptExportName(currentEntry.name_encrypted);',
      '    // Swipe-pager entry: it carries the file\'s own encrypted name.\n    if (currentEntry?.name_encrypted) return decryptExportName(currentEntry.name_encrypted);\n    if (isExportableDisplayName(currentFileName)) return currentFileName;',
    ),
  );
  guarded(
    'a route envelope is decrypted locally before the network is asked',
    preview,
    (s) => inOrder(body(s, RESOLVE), order),
    (s) => s.replace('    const fromRoute = await decryptExportName(currentFileName);\n    if (fromRoute) return fromRoute;\n', ''),
  );
  guarded(
    'a legacy bare name that starts with { is a name, not ciphertext',
    preview,
    (s) => {
      const b = body(s, DECRYPT);
      return (
        inOrder(b, [
          'const payload = encryptedMetadataPayloadToBytes(nameEncrypted);',
          'if (!payload) return isExportableDisplayName(nameEncrypted) ? nameEncrypted.trim() : null;',
          'decryptMetadata(currentFileId, payload.nonce, payload.ciphertext)',
        ]) && !b.includes("startsWith('{')")
      );
    },
    (s) => s.replace(
      'if (!payload) return isExportableDisplayName(nameEncrypted) ? nameEncrypted.trim() : null;',
      "if (!payload) return nameEncrypted.trim().startsWith('{') ? null : nameEncrypted.trim();",
    ),
  );
});

describe('Save to Files', () => {
  guarded(
    'only a plain extension (from the name, else the mime type) goes into the cache file URI',
    files,
    (s) => {
      const b = body(s, 'const extForSave = (): string => {');
      return (
        b.includes('? plainExtension(name.slice(dot + 1)) : null;') &&
        b.includes('const fromMime = plainExtension(mime.split(\'/\')[1]);') &&
        !/return name\.slice\(dot \+ 1\)/.test(b)
      );
    },
    // the shape before round 3: the raw extension of someone else's name
    (s) => s.replace('? plainExtension(name.slice(dot + 1)) : null;', '? name.slice(dot + 1).toLowerCase() : null;'),
  );
});
