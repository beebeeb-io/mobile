/**
 * Typed client model of the onboarding document (contract v1, task 1746).
 *
 * Source of truth: `src/contracts/onboarding/schema.v1.json` (a byte-identical
 * copy of `repos/server/contracts/onboarding/`, guarded by
 * `scripts/check-onboarding-contract.sh`). Spec:
 * docs/specs/2026-10-04-backend-driven-onboarding.md section 5.
 *
 * These types describe what the renderer READS after `parse.ts` has normalised
 * the raw JSON. They are deliberately forgiving: the schema validates the
 * server's output, a client is never a strict parser (spec 5.8 rule 2/3 and the
 * contract README, rule 3). Unknown fields are ignored; unknown enum values are
 * mapped to the safe value the spec names (step status -> `blocked`, purchase
 * surface -> `none`, fallback kind -> `unknown`).
 *
 * The web client has the same model (`repos/web/src/lib/onboarding/types.ts`,
 * task 1745). The two are kept in step by the shared fixtures, not by sharing
 * code: the web package is not a dependency of this app.
 */

/** The highest schema major this build understands. Sent as `X-Beebeeb-Onboarding-Schema`. */
export const SUPPORTED_SCHEMA = 1;

export type Stage = 'pre_account' | 'account';

/** Spec 5.8 rule 4: an unknown status is `blocked`. */
export type StepStatus = 'todo' | 'in_progress' | 'done' | 'blocked';

export type FallbackKind = 'update_app' | 'use_web' | 'contact_support' | 'unknown';

export interface Fallback {
  kind: FallbackKind;
  /** Only ever an `https:` URL (see `safeHttpsUrl`); anything else is dropped. */
  url: string | null;
}

export interface OnboardingStep {
  /** Open string: a newer server may send ids this build has never heard of. */
  id: string;
  status: StepStatus;
  required: boolean;
  ui: 'action' | 'info';
  params: Record<string, unknown>;
  fallback: Fallback | null;
}

export type ClientStatus = 'ok' | 'update_recommended' | 'update_required';

export interface ClientInfo {
  status: ClientStatus;
  minVersion: string | null;
  recommendedVersion: string | null;
}

export type SignupMode = 'native' | 'web_handoff' | 'web_only';

export interface SignupInfo {
  allowed: boolean;
  mode: SignupMode;
  reason: string | null;
  webUrl: string | null;
}

export interface BreachCheckPolicy {
  /** Same-origin path template, validated by `parse.ts` (`/api/...{prefix}...`). */
  endpoint: string | null;
  failOpen: boolean;
}

export interface SignupPolicy {
  password: { minLength: number; breachCheck: BreachCheckPolicy | null };
  recoveryPhrase: { wordCount: number; verifyWordCount: number };
  terms: { version: string; url: string | null; privacyUrl: string | null };
  emailCode: {
    length: number;
    ttlSeconds: number;
    resendAfterSeconds: number;
    ticketTtlSeconds: number;
  };
  pilotKeyRequired: boolean;
}

/** The closed v1 capability set (spec 5.8 rule 11). An absent capability is not allowed. */
export const CAPABILITY_NAMES = ['download', 'upload', 'share', 'delete'] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export interface Capability {
  allowed: boolean;
  reason: string | null;
  limitBytes: number | null;
  activeLinksLimit: number | null;
}

export interface StorageInfo {
  quotaBytes: number;
  usedBytes: number;
  allowanceBytes: number | null;
  overAllowance: boolean | null;
}

export interface TrialInfo {
  kind: 'no_card' | 'mandated' | 'promo' | 'unknown';
  startedAt: string | null;
  endsAt: string | null;
  capBytes: number | null;
  convertsAutomatically: boolean;
  firstChargeAt: string | null;
}

export interface LifecycleInfo {
  readOnlySince: string | null;
  dataDeletionAt: string | null;
  reason: string;
}

export interface AccountInfo {
  /** The raw label. Unknown values are kept: the state is only a label (rule 4). */
  state: string;
  emailVerified: boolean;
  capabilities: Partial<Record<CapabilityName, Capability>>;
  storage: StorageInfo | null;
  trial: TrialInfo | null;
  lifecycle: LifecycleInfo | null;
}

/** Spec 5.8 rule 4: an unknown surface is `none`. */
export type PurchaseSurface = 'none' | 'in_page' | 'system_browser' | 'external_link';

/**
 * The purchase surfaces this binary was built with (spec 5.1 principle 6, App
 * Review 2.3.1: nothing dormant or undocumented). The iOS launch binary has NONE:
 * no price, no purchase button, no external purchase link (App Store 3.1.3, tasks
 * 1400 and 1746). The server can only ACTIVATE a surface that is listed here, so
 * whatever the document says, `PurchaseInfo.ctaAllowed` is false for every
 * surface not in this list. Adding a surface needs a new build whose review notes
 * name it (task 1754), a DEVIATIONS.md line and a test change, in that order.
 */
export const COMPILED_PURCHASE_SURFACES: readonly PurchaseSurface[] = [];

export interface PurchaseInfo {
  surface: PurchaseSurface;
  /**
   * Money fails closed: true only when the server allows a call to action AND
   * this binary implements the surface (`COMPILED_PURCHASE_SURFACES`). Always
   * false in the launch binary.
   */
  ctaAllowed: boolean;
  priceVisibility: 'full' | 'hidden' | 'n/a';
  copy: Record<string, string>;
}

export interface OnboardingDocument {
  schema: number;
  stage: Stage;
  steps: OnboardingStep[];
  blocking: boolean;
  client: ClientInfo;
  copy: Record<string, string>;
  fallback: Fallback | null;
  signup: SignupInfo | null;
  policy: SignupPolicy | null;
  account: AccountInfo | null;
  purchase: PurchaseInfo | null;
  ttlSeconds: number | null;
}
