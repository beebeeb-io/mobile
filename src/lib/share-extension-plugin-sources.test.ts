// @ts-nocheck — bun runs this; `bun:test` types + `import.meta.dir` are not
// in the Expo tsconfig (same convention as FilesScreen.region.test.ts).
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Task 1594 round 5: sibling of file-provider-plugin-sources.test.ts, for
// the Share Extension's own plugin. `ShareUploadRequestPolicy.swift` (the
// new pure X-Beebeeb-Expected-User / 409 account_mismatch helper this round
// added) must be in `withShareExtension.js`'s SOURCE_FILES or a fresh
// `expo prebuild --clean` never copies it into `ios/BeebeebShare/`, and the
// target fails to compile against `ShareUploader.swift`'s new references to
// it. Written as a completeness check (not hardcoding the new filename) so
// the NEXT new file in this directory can't repeat the same gap Codex found
// in the sibling file-provider plugin.
const ROOT = join(import.meta.dir, '..', '..');

describe('share-extension plugin SOURCE_FILES completeness', () => {
  it('lists every .swift file that actually lives in targets/share-extension/', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plugin = require(join(ROOT, 'plugins/share-extension/withShareExtension.js'));
    const sourceFiles: unknown = plugin.SOURCE_FILES;
    expect(Array.isArray(sourceFiles)).toBe(true);

    const dir = join(ROOT, 'targets/share-extension');
    const actualSwiftFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.swift'))
      .sort();

    const missing = actualSwiftFiles.filter((f) => !(sourceFiles as string[]).includes(f));
    expect(missing).toEqual([]);

    const stale = (sourceFiles as string[]).filter((f) => !actualSwiftFiles.includes(f));
    expect(stale).toEqual([]);
  });
});
