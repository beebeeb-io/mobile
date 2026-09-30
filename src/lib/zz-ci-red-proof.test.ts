// RED-PROOF ONLY (task 1669 round 2) — deliberately failing; reverted in the next commit.
import { expect, test } from 'bun:test';
test('deliberate failure to prove the unit-tests CI job can go red', () => {
  expect(1 + 1).toBe(3);
});
