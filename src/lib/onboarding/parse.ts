/**
 * Tolerant parser for the onboarding document (task 1746, spec 5.8).
 *
 * `parseOnboardingDocument` turns untrusted JSON into the typed model in
 * `types.ts`. It is NOT a schema validator: unknown fields are ignored, unknown
 * enum values degrade to the value the spec names, and only a document the
 * renderer cannot meaningfully draw is rejected. Rejection has two shapes:
 *
 *   - `unsupported_schema`: the server answered a major above ours. Rule 5:
 *     show "update" with the hard-coded web fallback, never guess.
 *   - `malformed`: not an onboarding document at all. The caller treats it
 *     exactly like a failed fetch (rule 6: legacy `/billing/subscription`
 *     fallback).
 *
 * Two inputs from the document are links or request paths and are therefore
 * checked here once, so no component ever has to remember to: external URLs
 * must be `https:` (`safeHttpsUrl`), and the breach-check endpoint must be a
 * same-origin `/api/v1/...` path (`sameOriginApiPath`, contract README rule 8).
 * A value that fails is dropped (null), not repaired.
 *
 * Money: this build has NO purchase UI (`COMPILED_PURCHASE_SURFACES` is empty).
 * The parser therefore does not read `offers` at all (there is no field for it
 * in the model), and `PurchaseInfo.ctaAllowed` is false for every surface the
 * binary does not implement, whatever the server says.
 *
 * Pure: no React, no native modules, no `URL` global (Hermes' is partial).
 */

import {
  CAPABILITY_NAMES,
  COMPILED_PURCHASE_SURFACES,
  SUPPORTED_SCHEMA,
  type AccountInfo,
  type Capability,
  type CapabilityName,
  type ClientInfo,
  type Fallback,
  type FallbackKind,
  type LifecycleInfo,
  type OnboardingDocument,
  type OnboardingStep,
  type PurchaseInfo,
  type PurchaseSurface,
  type SignupInfo,
  type SignupMode,
  type SignupPolicy,
  type StepStatus,
  type StorageInfo,
  type TrialInfo,
} from './types';

export type ParseResult =
  | { ok: true; doc: OnboardingDocument }
  | { ok: false; reason: 'unsupported_schema'; schema: number }
  | { ok: false; reason: 'malformed'; detail: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0 ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** `https://host[/path][?query][#fragment]`, no whitespace, no userinfo. */
const HTTPS_URL_RE = /^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?([/?#][^\s]*)?$/;

/** `https:` URLs only; everything else (javascript:, data:, http:, relative, userinfo) is dropped. */
export function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return HTTPS_URL_RE.test(v) ? v : null;
}

const API_PATH_RE = /^\/api\/v1\/[A-Za-z0-9._~\-/{}]*$/;

/**
 * A same-origin API path. Rejects absolute URLs, protocol-relative `//host`,
 * traversal and anything outside `/api/v1/` (contract README rule 8).
 */
export function sameOriginApiPath(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (!API_PATH_RE.test(v)) return null;
  if (v.includes('//') || v.includes('..')) return null;
  return v;
}

function copyMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

const FALLBACK_KINDS: readonly FallbackKind[] = ['update_app', 'use_web', 'contact_support'];

function parseFallback(v: unknown): Fallback | null {
  if (!isObj(v)) return null;
  const kind = FALLBACK_KINDS.find((k) => k === v.kind) ?? 'unknown';
  return { kind, url: safeHttpsUrl(v.url) };
}

const STEP_STATUSES: readonly StepStatus[] = ['todo', 'in_progress', 'done', 'blocked'];

function parseStep(v: unknown): OnboardingStep | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  // Rule 4: an unknown (or missing) status is `blocked`.
  const status = STEP_STATUSES.find((s) => s === v.status) ?? 'blocked';
  return {
    id,
    status,
    // A step that does not say it is optional is required: fail toward stopping.
    required: v.required === false ? false : true,
    ui: v.ui === 'info' ? 'info' : 'action',
    params: isObj(v.params) ? v.params : {},
    fallback: parseFallback(v.fallback),
  };
}

function parseClient(v: unknown): ClientInfo {
  const o = isObj(v) ? v : {};
  const status =
    o.status === 'update_required' || o.status === 'update_recommended' ? o.status : 'ok';
  return { status, minVersion: str(o.min_version), recommendedVersion: str(o.recommended_version) };
}

function parseSignup(v: unknown): SignupInfo | null {
  if (!isObj(v)) return null;
  const mode: SignupMode =
    v.mode === 'native' || v.mode === 'web_handoff' ? v.mode : 'web_only';
  return {
    allowed: v.allowed === true,
    mode,
    reason: str(v.reason),
    webUrl: safeHttpsUrl(v.web_url),
  };
}

function parsePolicy(v: unknown): SignupPolicy | null {
  if (!isObj(v)) return null;
  const pw = isObj(v.password) ? v.password : null;
  const rp = isObj(v.recovery_phrase) ? v.recovery_phrase : null;
  const terms = isObj(v.terms) ? v.terms : null;
  const ec = isObj(v.email_code) ? v.email_code : null;
  if (!pw || !rp || !terms || !ec) return null;
  const minLength = int(pw.min_length);
  const termsVersion = str(terms.version);
  if (minLength === null || termsVersion === null) return null;

  let breachCheck: SignupPolicy['password']['breachCheck'] = null;
  if (isObj(pw.breach_check)) {
    const endpoint = sameOriginApiPath(pw.breach_check.endpoint);
    breachCheck = {
      // The template must name the prefix slot exactly once; otherwise the
      // check cannot be addressed and counts as an outage in the ceremony.
      endpoint: endpoint && endpoint.split('{prefix}').length === 2 ? endpoint : null,
      // fail_open is the document's to declare (the ceremony enforces it once).
      failOpen: pw.breach_check.fail_open !== false,
    };
  }

  return {
    password: { minLength, breachCheck },
    recoveryPhrase: {
      wordCount: int(rp.word_count) ?? 12,
      verifyWordCount: int(rp.verify_word_count) ?? 3,
    },
    terms: { version: termsVersion, url: safeHttpsUrl(terms.url), privacyUrl: safeHttpsUrl(terms.privacy_url) },
    emailCode: {
      length: int(ec.length) ?? 8,
      ttlSeconds: int(ec.ttl_seconds) ?? 900,
      resendAfterSeconds: int(ec.resend_after_seconds) ?? 60,
      ticketTtlSeconds: int(ec.ticket_ttl_seconds) ?? 1800,
    },
    pilotKeyRequired: isObj(v.pilot_key) && v.pilot_key.required === true,
  };
}

function parseCapability(v: unknown): Capability | null {
  if (!isObj(v) || typeof v.allowed !== 'boolean') return null;
  return {
    allowed: v.allowed,
    reason: str(v.reason),
    limitBytes: int(v.limit_bytes),
    activeLinksLimit: isObj(v.limit) ? int(v.limit.active_links) : null,
  };
}

function parseStorage(v: unknown): StorageInfo | null {
  if (!isObj(v)) return null;
  const quota = int(v.quota_bytes);
  const used = int(v.used_bytes);
  if (quota === null || used === null) return null;
  return {
    quotaBytes: quota,
    usedBytes: used,
    allowanceBytes: int(v.allowance_bytes),
    overAllowance: bool(v.over_allowance),
  };
}

function parseTrial(v: unknown): TrialInfo | null {
  if (!isObj(v)) return null;
  const kind =
    v.kind === 'no_card' || v.kind === 'mandated' || v.kind === 'promo' ? v.kind : 'unknown';
  return {
    kind,
    startedAt: str(v.started_at),
    endsAt: str(v.ends_at),
    capBytes: int(v.cap_bytes),
    convertsAutomatically: v.converts_automatically === true,
    firstChargeAt: str(v.first_charge_at),
  };
}

function parseLifecycle(v: unknown): LifecycleInfo | null {
  if (!isObj(v)) return null;
  return {
    readOnlySince: str(v.read_only_since),
    dataDeletionAt: str(v.data_deletion_at),
    reason: str(v.reason) ?? '',
  };
}

function parseAccount(v: unknown): AccountInfo | null {
  if (!isObj(v)) return null;
  const state = str(v.state);
  if (!state) return null;
  const capabilities: Partial<Record<CapabilityName, Capability>> = {};
  if (isObj(v.capabilities)) {
    // Closed set per major (rule 11): names outside it are not capabilities.
    for (const name of CAPABILITY_NAMES) {
      const cap = parseCapability(v.capabilities[name]);
      if (cap) capabilities[name] = cap;
    }
  }
  return {
    state,
    emailVerified: v.email_verified === true,
    capabilities,
    storage: parseStorage(v.storage),
    trial: parseTrial(v.trial),
    lifecycle: parseLifecycle(v.lifecycle),
  };
}

const SURFACES: readonly PurchaseSurface[] = ['none', 'in_page', 'system_browser', 'external_link'];

function parsePurchase(v: unknown): PurchaseInfo | null {
  if (!isObj(v)) return null;
  // Rule 4: unknown surface is `none`.
  const surface = SURFACES.find((s) => s === v.surface) ?? 'none';
  const priceVisibility =
    v.price_visibility === 'full' || v.price_visibility === 'n/a' ? v.price_visibility : 'hidden';
  return {
    surface,
    // Money fails closed twice: the server must allow it AND this binary must
    // implement the surface (principle 6). The launch binary implements none.
    ctaAllowed: v.cta_allowed === true && COMPILED_PURCHASE_SURFACES.includes(surface),
    priceVisibility,
    copy: copyMap(v.copy),
  };
}

export function parseOnboardingDocument(raw: unknown): ParseResult {
  if (!isObj(raw)) return { ok: false, reason: 'malformed', detail: 'not an object' };
  const schema = int(raw.schema);
  if (schema === null || schema < 1) return { ok: false, reason: 'malformed', detail: 'no schema major' };
  if (schema > SUPPORTED_SCHEMA) return { ok: false, reason: 'unsupported_schema', schema };

  const stage = raw.stage;
  if (stage !== 'pre_account' && stage !== 'account') {
    return { ok: false, reason: 'malformed', detail: 'unknown stage' };
  }
  if (!Array.isArray(raw.steps)) return { ok: false, reason: 'malformed', detail: 'steps is not a list' };

  const steps: OnboardingStep[] = [];
  for (const s of raw.steps) {
    const step = parseStep(s);
    if (step) steps.push(step);
  }

  const doc: OnboardingDocument = {
    schema,
    stage,
    steps,
    blocking: raw.blocking === true,
    client: parseClient(raw.client),
    copy: copyMap(raw.copy),
    fallback: parseFallback(raw.fallback),
    signup: parseSignup(raw.signup),
    policy: parsePolicy(raw.policy),
    account: parseAccount(raw.account),
    purchase: parsePurchase(raw.purchase),
    ttlSeconds: int(raw.ttl_seconds),
  };

  // A blocking update screen needs nothing but the client block and a fallback
  // (rule 7), so a stage-incomplete document still reaches it.
  const updateRequired = doc.client.status === 'update_required';
  if (!updateRequired && stage === 'pre_account' && (!doc.signup || !doc.policy)) {
    return { ok: false, reason: 'malformed', detail: 'pre_account without signup and policy' };
  }
  if (!updateRequired && stage === 'account' && (!doc.account || !doc.purchase)) {
    return { ok: false, reason: 'malformed', detail: 'account without account and purchase' };
  }

  return { ok: true, doc };
}
