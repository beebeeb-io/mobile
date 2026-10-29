/**
 * Test helper: the contract's golden fixtures, read from the vendored copy
 * (`src/contracts/onboarding/fixtures`, byte-identical to the server's; the
 * drift guard is `scripts/check-onboarding-contract.sh`).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '..', '..', 'contracts', 'onboarding', 'fixtures');

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));
}
