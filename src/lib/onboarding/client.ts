/**
 * Fetching the onboarding document (task 1746, spec 5.2 and 5.8 rule 6).
 *
 * Every outcome is a value, never a throw, because the caller's job is to pick a
 * screen: a 404 (old server), a network failure and a document we cannot draw all
 * mean the same thing, "use the legacy path" (rule 6), and only a document newer
 * than we understand means "update".
 */

import { parseOnboardingDocument } from './parse';
import type { OnboardingDocument } from './types';

export type FetchOutcome =
  | { kind: 'document'; doc: OnboardingDocument }
  | { kind: 'unsupported_schema' }
  | { kind: 'legacy'; reason: 'not_found' | 'unauthorized' | 'network' | 'malformed' };

/** The transport: `api.ts` `fetchOnboardingRaw`. Injected so this module needs no native mocks. */
export type RawFetcher = (signedIn: boolean) => Promise<unknown>;

export async function fetchOnboardingDocument(fetchRaw: RawFetcher, signedIn: boolean): Promise<FetchOutcome> {
  let raw: unknown;
  try {
    raw = await fetchRaw(signedIn);
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    if (status === 404 || status === 405) return { kind: 'legacy', reason: 'not_found' };
    if (status === 401) return { kind: 'legacy', reason: 'unauthorized' };
    return { kind: 'legacy', reason: 'network' };
  }
  return outcomeFromRaw(raw);
}

/** Split out so the 404 / garbage / newer-major cases are unit-testable without a network. */
export function outcomeFromRaw(raw: unknown): FetchOutcome {
  const parsed = parseOnboardingDocument(raw);
  if (parsed.ok) return { kind: 'document', doc: parsed.doc };
  if (parsed.reason === 'unsupported_schema') return { kind: 'unsupported_schema' };
  return { kind: 'legacy', reason: 'malformed' };
}
