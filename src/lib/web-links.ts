/**
 * Web account links (task 1037).
 *
 * The app no longer creates accounts. Sign-up and plan choice happen in the
 * web app, and login stays native.
 *
 * `WEB_ACCOUNT_LINKS_ENABLED` ships OFF. That follows the repo's App Review
 * rule (task 1400, 3.1.1(a)): with no In-App Purchase product, the app shows
 * no button or URL that leads to a purchase flow, and the web sign-up and
 * plan chooser both show trial prices. With the switch off, both screens say
 * in plain text where to go. Turning it on (for example once an External
 * Purchase Link entitlement exists) makes the same screens render a link
 * built from `resolveWebAppUrl`, with no other code changes.
 *
 * Pure module, no imports, so it is unit-testable without native mocks.
 * `getWebAppUrl()` in api.ts feeds it the build's configuration.
 */

export const WEB_ACCOUNT_LINKS_ENABLED = false;

export const PRODUCTION_WEB_APP_URL = 'https://app.beebeeb.io';

/** Port the web app's Vite dev server listens on (repos/web vite.config.ts). */
const LOCAL_WEB_DEV_PORT = '5173';
const LOCAL_API_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * The web app's base URL for this build:
 *  1. an explicit override (`extra.appUrl` / `EXPO_PUBLIC_APP_URL`);
 *  2. derived from the API URL: `api.<host>` becomes `app.<host>`, and a
 *     local dev API becomes the local web dev server on the same host;
 *  3. otherwise production. It never falls back to the API host itself.
 */
export function resolveWebAppUrl(input: { configuredAppUrl?: string | null; apiUrl?: string | null }): string {
  const configured = input.configuredAppUrl?.trim();
  if (configured) return trimTrailingSlash(configured);

  let api: URL;
  try {
    api = new URL(input.apiUrl ?? '');
  } catch {
    return PRODUCTION_WEB_APP_URL;
  }

  if (LOCAL_API_HOSTS.has(api.hostname)) {
    return `${api.protocol}//${api.hostname}:${LOCAL_WEB_DEV_PORT}`;
  }
  if (api.hostname.startsWith('api.') && api.protocol === 'https:') {
    return `https://app.${api.hostname.slice('api.'.length)}`;
  }
  return PRODUCTION_WEB_APP_URL;
}

export function webAppLink(base: string, path: string): string {
  return `${trimTrailingSlash(base)}/${path.replace(/^\/+/, '')}`;
}

export const SIGNUP_PATH = '/signup';
export const CHOOSE_PLAN_PATH = '/choose-plan';

export interface LinkCopy {
  text: string;
  /** Label of the tappable link, or null when the copy is text-only. */
  linkLabel: string | null;
}

/** Login screen footer. */
export function createAccountCopy(linksEnabled: boolean): LinkCopy {
  if (linksEnabled) return { text: 'No account yet?', linkLabel: 'Create account' };
  return { text: 'Create your account on the web at beebeeb.io, then sign in here.', linkLabel: null };
}

export interface NeedsPlanCopy {
  title: string;
  body: string;
  linkLabel: string | null;
}

/** The full-screen state for a `needs_plan` account. */
export function needsPlanCopy(linksEnabled: boolean): NeedsPlanCopy {
  const title = 'Finish setting up your account';
  if (linksEnabled) {
    return {
      title,
      body: 'Choose your plan on beebeeb.io to start using Beebeeb. When you are done, tap Refresh.',
      linkLabel: 'Open beebeeb.io',
    };
  }
  return {
    title,
    body: 'Choose your plan on the web at beebeeb.io to start using Beebeeb. When you are done, tap Refresh.',
    linkLabel: null,
  };
}
