/**
 * Pure half of the signed-out document use (task 1746): the state the hook holds and
 * the one question the signed-out screens ask of it.
 */
import type { OnboardingDocument } from './types';

export type PreAccountState =
  | { status: 'loading' }
  | { status: 'document'; doc: OnboardingDocument }
  | { status: 'unsupported_schema' }
  | { status: 'legacy'; reason: string };

/** True when the document says this build may sign up natively. */
export function canSignUpNatively(state: PreAccountState): boolean {
  return (
    state.status === 'document' &&
    state.doc.stage === 'pre_account' &&
    state.doc.client.status !== 'update_required' &&
    state.doc.signup?.allowed === true &&
    state.doc.signup.mode === 'native'
  );
}
