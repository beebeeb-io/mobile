// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Task 2262 — FilesScreen called `GET /api/v1/files/:id/presence` on every
// folder open. The server (repos/server origin/main) has no such route, so the
// call 404s every time and the avatar strip it feeds is never populated. No
// spec asks for folder presence (the call arrived inside a broad feature
// commit, 03c0828e "presence avatars", with no route behind it), so the call
// goes away rather than the server growing a route.
//
// Same source-text convention as FilesScreen.region.test.ts: mounting this
// screen is not what these guards are about. What they prove:
//   1. the screen contains no presence fetch and no presence UI,
//   2. the api client can no longer issue such a request (no helper, no path),
//   3. the dead PresenceAvatars component is gone.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const screenSource = readFileSync(join(dir, 'FilesScreen.tsx'), 'utf-8');
const apiSource = readFileSync(join(dir, '..', 'lib', 'api.ts'), 'utf-8');

describe('FilesScreen makes no request to an unserved presence route (task 2262)', () => {
  test('the screen never names the presence call', () => {
    expect(screenSource).not.toContain('getFolderPresence');
    expect(screenSource).not.toContain('PresenceAvatars');
    expect((screenSource.match(/presence/gim) ?? []).length).toBe(0);
  });

  test('the api client has no presence route (server serves none)', () => {
    expect(apiSource).not.toContain('/presence');
    expect(apiSource).not.toContain('getFolderPresence');
    expect(apiSource).not.toContain('PresenceUser');
  });

  test('the dead PresenceAvatars component is removed', () => {
    expect(existsSync(join(dir, '..', 'components', 'PresenceAvatars.tsx'))).toBe(false);
  });
});
