/**
 * Shared, non-tappable billing copy (task 1400 / 1540).
 *
 * No purchase or subscription-management call to action lives anywhere in
 * this app (task 1400, App Review 3.1.1(a) — no In-App Purchase product is
 * configured). `PLAN_MANAGEMENT_NOTE` is the one sentence every screen that
 * talks about plans/storage limits uses to say the same true thing, so the
 * language can't drift out of sync between screens again — task 1540 found
 * exactly that drift: StorageScreen said "Plans are managed from your
 * account on the web" while Settings and Files still promised an in-app
 * "Upgrade" action that did not exist.
 */
export const PLAN_MANAGEMENT_NOTE = 'Plans are managed from your account on the web.';
