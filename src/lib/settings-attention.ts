/**
 * Task 2245 (P1) — the Settings tab showed a "!" that Settings itself never
 * explained.
 *
 * This module is the ONE decision both surfaces read: the tab badge
 * (`App.tsx` TabNavigator) and the Settings root rows
 * (`components/settings/SettingsCategories.tsx`). Keeping the computation
 * pure means the badge and the rows can never disagree, and the reason text
 * is testable without a renderer.
 *
 * No new colours/tokens: callers paint these with an existing warning token.
 */

/** Storage is "close to full" at the same ratio the old badge used. */
export const STORAGE_ATTENTION_RATIO = 0.8;

export type SettingsAttentionReason =
  | { id: 'backups'; message: string }
  | { id: 'account'; message: string };

export interface SettingsAttention {
  /** Items the native backup engine has dead-lettered (still failing). */
  backupFailedCount: number;
  /** Whole-percent plan usage, or null when the plan limit is unknown. */
  storagePercent: number | null;
  reasons: SettingsAttentionReason[];
  /** The tab badge string, or undefined when there is nothing to report. */
  badge: '!' | undefined;
}

export interface SettingsAttentionInput {
  backupFailedCount?: number | null;
  usedBytes?: number | null;
  limitBytes?: number | null;
}

/** "3 items need attention" / "1 item needs attention" — no "(s)". */
export function backupAttentionMessage(count: number): string {
  return count === 1 ? '1 item needs attention' : `${count.toLocaleString()} items need attention`;
}

/**
 * The native bottom-tab badge value. NEVER `undefined`: removing that prop
 * leaves the previous badge painted on the native tab bar (task 2245 rung),
 * so the clear state is the empty string, which the tab view converts to nil.
 */
export function settingsTabBadge(attention: Pick<SettingsAttention, 'badge'>): string {
  return attention.badge ?? '';
}

export function storageAttentionMessage(percent: number): string {
  return `Storage ${percent}% full`;
}

export function computeSettingsAttention(input: SettingsAttentionInput): SettingsAttention {
  const rawCount = Number.isFinite(input.backupFailedCount) ? Number(input.backupFailedCount) : 0;
  const backupFailedCount = Math.max(0, Math.floor(rawCount));

  const used = Number.isFinite(input.usedBytes) ? Math.max(0, Number(input.usedBytes)) : 0;
  const limit = Number.isFinite(input.limitBytes) ? Number(input.limitBytes) : 0;
  const ratio = limit > 0 ? used / limit : 0;
  const storagePercent = limit > 0 ? Math.min(100, Math.floor(ratio * 100)) : null;

  const reasons: SettingsAttentionReason[] = [];
  if (backupFailedCount > 0) {
    reasons.push({ id: 'backups', message: backupAttentionMessage(backupFailedCount) });
  }
  if (storagePercent !== null && ratio >= STORAGE_ATTENTION_RATIO) {
    reasons.push({ id: 'account', message: storageAttentionMessage(storagePercent) });
  }

  return {
    backupFailedCount,
    storagePercent,
    reasons,
    badge: reasons.length > 0 ? '!' : undefined,
  };
}
