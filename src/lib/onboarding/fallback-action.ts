/**
 * What a document `fallback` becomes on THIS binary (task 1746, spec 5.8 rule 3).
 *
 * The server names the way out of a step this build cannot do:
 *   - `update_app`      -> the App Store page of this app (allowed on iOS);
 *   - `contact_support` -> a mail to support;
 *   - `use_web`         -> the web. The app ships `WEB_ACCOUNT_LINKS_ENABLED` OFF
 *                          (App Review 3.1.1(a), task 1400: the web signup and plan
 *                          pages show prices), so with links off this is plain
 *                          text, never a tappable link.
 *   - unknown kind      -> plain text.
 *
 * Pure: the caller decides how to open a URL.
 */

import type { Fallback } from './types';

/** `ascAppId` in eas.json. */
export const APP_STORE_URL = 'itms-apps://apps.apple.com/app/id6766666400';
export const SUPPORT_MAILTO = 'mailto:support@beebeeb.io';

export type FallbackAction =
  | { kind: 'open'; url: string; label: string }
  | { kind: 'text'; text: string };

export function fallbackAction(fallback: Fallback | null | undefined, webLinksEnabled: boolean): FallbackAction {
  switch (fallback?.kind) {
    case 'update_app':
      return { kind: 'open', url: APP_STORE_URL, label: 'Update in the App Store' };
    case 'contact_support':
      return { kind: 'open', url: SUPPORT_MAILTO, label: 'Contact support' };
    case 'use_web':
      if (webLinksEnabled && fallback.url) return { kind: 'open', url: fallback.url, label: 'Continue on the web' };
      return { kind: 'text', text: 'You can finish this on the web at beebeeb.io, then come back and sign in here.' };
    default:
      return { kind: 'text', text: 'This step is newer than this version of the app. Update the app, or finish it on the web at beebeeb.io.' };
  }
}
