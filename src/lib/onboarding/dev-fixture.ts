/**
 * DEV-ONLY: render the account-stage UI from a contract fixture (task 1746).
 *
 * The local server cannot yet produce `trialing_no_card` or `trial_ended` (the
 * trial lifecycle is task 1755, not on server main), but the Verification line
 * asks for a no-purchase check on exactly those screens. In a debug build,
 * `beebeeb://dev/onboarding-fixture?name=account.trial_ended.ios` makes the
 * account-state provider use that golden document instead of the server's, so the
 * REAL screens (Files banner, Storage status card) render the REAL parser output.
 * `name=off` removes the override.
 *
 * Inert in a release build: every entry point is guarded by `__DEV__`, which Metro
 * folds to false, so the fixture requires below are dead code there.
 */
import { parseOnboardingDocument } from './parse';
import type { OnboardingDocument } from './types';

let override: OnboardingDocument | null = null;

export function getDevDocumentOverride(): OnboardingDocument | null {
  return __DEV__ ? override : null;
}

export function setDevDocumentOverride(doc: OnboardingDocument | null): void {
  if (__DEV__) override = doc;
}

function fixtureJson(name: string): unknown {
  if (!__DEV__) return null;
  switch (name) {
    case 'account.allowance.ios':
      return require('../../contracts/onboarding/fixtures/account.allowance.ios.json');
    case 'account.trialing_no_card.desktop':
      return require('../../contracts/onboarding/fixtures/account.trialing_no_card.desktop.json');
    case 'account.trial_ended.ios':
      return require('../../contracts/onboarding/fixtures/account.trial_ended.ios.json');
    case 'account.lapsed.ios':
      return require('../../contracts/onboarding/fixtures/account.lapsed.ios.json');
    case 'account.needs_plan.ios':
      return require('../../contracts/onboarding/fixtures/account.needs_plan.ios.json');
    case 'client.update_required.ios':
      return require('../../contracts/onboarding/fixtures/client.update_required.ios.json');
    default:
      return null;
  }
}

/** Parse a bundled fixture by name, or null (unknown name, release build, unparseable). */
export function loadDevFixture(name: string): OnboardingDocument | null {
  const raw = fixtureJson(name);
  if (!raw) return null;
  const parsed = parseOnboardingDocument(raw);
  return parsed.ok ? parsed.doc : null;
}

/** Apply a `name` query value. Returns true when the override changed. */
export function applyDevFixtureName(name: string | null | undefined): boolean {
  if (!__DEV__) return false;
  if (!name || name === 'off') {
    const had = override !== null;
    override = null;
    return had;
  }
  const doc = loadDevFixture(name);
  if (!doc) return false;
  override = doc;
  return true;
}
