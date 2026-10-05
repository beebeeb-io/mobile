/**
 * The one host-side call of the breach gate (task 1746; web task 1795).
 *
 * The prefix is read ONCE and the same value goes into the request URL and into
 * `evaluate(requestedPrefix, ...)`: core compares them and refuses
 * (`breach_prefix_mismatch`, recorded as nothing) rather than letting a body
 * fetched for another prefix read as "clean".
 *
 * An invalid or missing endpoint counts as an outage: a null body, and core
 * applies the document's `fail_open` (the ceremony enforces it, a client cannot
 * pick it per call).
 */

import type { BreachVerdict } from '../../../modules/beebeeb-crypto/src/BeebeebOnboarding';

export interface BreachLike {
  readonly prefix: string;
  evaluate(requestedPrefix: string, body: string | null, failOpen: boolean): Promise<BreachVerdict>;
}

export async function runBreachCheck(
  fetchBreachBody: (endpoint: string, prefix: string) => Promise<string | null>,
  breach: BreachLike,
  bc: { endpoint?: string | null; failOpen: boolean },
): Promise<BreachVerdict> {
  const prefix = breach.prefix;
  let body: string | null = null;
  if (bc.endpoint) {
    try {
      body = await fetchBreachBody(bc.endpoint, prefix);
    } catch {
      body = null; // any failure is an outage, never a clean answer
    }
  }
  return breach.evaluate(prefix, body, bc.failOpen);
}
