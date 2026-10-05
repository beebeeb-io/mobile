/**
 * Which account gate and onboarding document the app holds after a refresh
 * (task 1746, spec 5.8 rules 5 and 6). Pure, so every combination of "subscription
 * fetched / document fetched / each failed" is tested.
 *
 *   - A usable ACCOUNT document decides the gate from its capabilities
 *     (`gateFromDocument`). The legacy label cannot tell an `allowance` vault from
 *     a `needs_plan` one, so the document wins whenever it is there.
 *   - A document we cannot use (404 on an old server, malformed, 401) means the
 *     legacy `/billing/subscription` gate, exactly as before (rule 6). The document
 *     is cleared: it is no longer true.
 *   - A newer schema major than we understand (rule 5) is remembered so the app can
 *     say "update", and the legacy gate keeps the vault usable meanwhile.
 *   - A NETWORK failure keeps what was last known: a flaky connection must never
 *     lock anyone out or unlock a read-only vault (the server enforces either way).
 */

import { accountGateFor, type AccountGate, type AccountStateFields } from '../account-state';
import { gateFromDocument } from './account-gate';
import type { FetchOutcome } from './client';
import type { OnboardingDocument } from './types';

export interface AccountSnapshot {
  gate: AccountGate;
  document: OnboardingDocument | null;
  unsupportedSchema: boolean;
}

export function decideAccountState(input: {
  /** `/billing/subscription`, or null when it could not be read. */
  subscription: AccountStateFields | null;
  /** The document fetch, or null when it was not attempted. */
  outcome: FetchOutcome | null;
  previous: AccountSnapshot;
}): AccountSnapshot {
  const { subscription, outcome, previous } = input;
  const legacy = (): AccountGate => (subscription ? accountGateFor(subscription) : previous.gate);

  if (outcome?.kind === 'document' && outcome.doc.stage === 'account' && outcome.doc.account) {
    const fromDoc = gateFromDocument(outcome.doc);
    return { gate: fromDoc ?? legacy(), document: outcome.doc, unsupportedSchema: false };
  }
  if (outcome?.kind === 'unsupported_schema') {
    return { gate: legacy(), document: null, unsupportedSchema: true };
  }
  if (outcome?.kind === 'document') {
    // A pre_account document for a signed-in caller: not for us. Treat as unusable.
    return { gate: legacy(), document: null, unsupportedSchema: false };
  }
  if (outcome?.kind === 'legacy' && outcome.reason !== 'network') {
    return { gate: legacy(), document: null, unsupportedSchema: false };
  }
  // Network failure or nothing attempted: keep what we last knew.
  if (previous.document) {
    return { gate: previous.gate, document: previous.document, unsupportedSchema: previous.unsupportedSchema };
  }
  return { gate: legacy(), document: null, unsupportedSchema: previous.unsupportedSchema };
}
