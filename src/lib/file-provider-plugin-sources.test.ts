// @ts-nocheck — bun runs this; `bun:test` types + `import.meta.dir` are not
// in the Expo tsconfig (same convention as FilesScreen.region.test.ts).
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Task 1594 round 5 (Codex P1, ios/Beebeeb.xcodeproj/project.pbxproj:809):
// `plugins/file-provider/withFileProvider.js`'s `SOURCE_FILES` list is what
// `ensureExtensionWiring` uses to (re)build the BeebeebFileProvider target's
// PBXSourcesBuildPhase on every `expo prebuild` (with or without --clean).
// The COMMITTED project.pbxproj can carry hand-wired entries a plugin run
// would silently drop the next time it regenerates the Sources phase from
// scratch — that already happened once (CachedHandleIdentity.swift /
// AccountMismatchDetection.swift were hand-wired into project.pbxproj in
// rounds 3/4 but never added here). This test diffs the plugin's own
// declared list against the real files on disk so a THIRD file added the
// same way can never regress silently again.
const ROOT = join(import.meta.dir, '..', '..');

describe('file-provider plugin SOURCE_FILES completeness', () => {
  it('lists every .swift file that actually lives in targets/file-provider/', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plugin = require(join(ROOT, 'plugins/file-provider/withFileProvider.js'));
    const sourceFiles: unknown = plugin.SOURCE_FILES;
    expect(Array.isArray(sourceFiles)).toBe(true);

    const dir = join(ROOT, 'targets/file-provider');
    const actualSwiftFiles = readdirSync(dir)
      .filter((f) => f.endsWith('.swift'))
      .sort();

    const missing = actualSwiftFiles.filter((f) => !(sourceFiles as string[]).includes(f));
    expect(missing).toEqual([]);

    // Guards the other direction too: a stale entry naming a file that no
    // longer exists would silently break `expo prebuild --clean` the same
    // way a missing one would (a copy/reference to nothing).
    const stale = (sourceFiles as string[]).filter((f) => !actualSwiftFiles.includes(f));
    expect(stale).toEqual([]);
  });
});
