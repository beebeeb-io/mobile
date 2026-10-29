/**
 * The account gate from the onboarding document (task 1746, spec 5.6, 5.8).
 *
 * The existing gate (`account-state.ts`) is derived from `/billing/subscription`'s
 * `account_state`. That label cannot tell an `allowance` account (a working 2 GB
 * vault, spec 4.5) from a `needs_plan` one: the legacy mapping gives BOTH
 * `needs_plan` (4b.8), which would put a full-screen block over a perfectly good
 * vault. The document carries the capabilities, which are the decision inputs
 * (rule 4: the state enum is only a label), so the gate is read from them:
 *
 *   - upload allowed                       -> ok (download/share are not a gate)
 *   - upload refused, `trial_ended`        -> trial_ended (read-only above the allowance)
 *   - upload refused, `plan_required`      -> needs_plan (allowance off or email unverified)
 *   - upload refused, `email_unverified`   -> needs_plan (the verify_email step explains it)
 *   - upload refused, `trial_cancelled_read_only` -> that gate, as before
 *   - any other refusal                    -> lapsed (read-only; download and export stay)
 *
 * `null` means "this document says nothing usable about uploads": the caller falls
 * back to the legacy gate (rule 6).
 */

import type { AccountGate } from '../account-state';
import { formatSize, noPurchaseCopy, trialEndedFilesKept } from './account-summary';
import type { OnboardingDocument } from './types';

export function gateFromDocument(doc: OnboardingDocument | null | undefined): AccountGate | null {
  if (!doc || doc.stage !== 'account' || !doc.account) return null;
  const upload = doc.account.capabilities.upload;
  // Closed set per major (rule 11): an absent capability is "not allowed", but a
  // document with NO capabilities at all is not one we can decide from.
  if (!upload && Object.keys(doc.account.capabilities).length === 0) return null;
  if (upload?.allowed) return { kind: 'ok' };

  const reason = upload?.reason ?? null;
  const deletion = doc.account.lifecycle?.dataDeletionAt ?? null;
  switch (reason) {
    case 'trial_ended': {
      // Explicit within-allowance evidence only; unknown stays read-only copy.
      if (trialEndedFilesKept(doc)) {
        const allowance = doc.account.storage?.allowanceBytes;
        return {
          kind: 'trial_ended',
          dataDeletionAt: null,
          filesKept: true,
          bannerText:
            allowance != null
              ? `Your trial ended. Your files are kept, within your ${formatSize(allowance)} allowance.`
              : 'Your trial ended. Your files are kept, within your allowance.',
        };
      }
      return {
        kind: 'trial_ended',
        dataDeletionAt: deletion,
        bannerText: noPurchaseCopy(doc.copy.trial_ended_over_allowance),
      };
    }
    case 'plan_required':
    case 'email_unverified':
      return { kind: 'needs_plan' };
    case 'trial_cancelled_read_only':
      return {
        kind: 'trial_cancelled_read_only',
        accessUntil: doc.account.trial?.endsAt ?? null,
        dataDeletionAt: deletion,
      };
    default:
      return { kind: 'lapsed', dataDeletionAt: deletion };
  }
}
