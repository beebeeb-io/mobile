/**
 * Which screen, if any, covers the file UI for a signed-in account (task 1746).
 * Pure given its inputs; the React side is `components/onboarding/AccountOverlay`.
 *
 * Covers only what the document says must come first (`blocking`) AND this build can
 * show: a step it can do, a client that is too old, a schema it does not understand,
 * a required step it cannot do or that is blocked. A working vault (`account`) is
 * never covered: its status text lives in Storage and Files.
 */
import { planScreen, unsupportedSchemaScreen, type Screen } from './plan';
import type { OnboardingDocument } from './types';

export function overlayScreen(document: OnboardingDocument | null, unsupportedSchema: boolean): Screen | null {
  if (document) {
    const screen = planScreen(document);
    switch (screen.kind) {
      case 'update_required':
      case 'step':
      case 'fallback':
      case 'blocked':
        return screen;
      default:
        return null; // 'account': a working vault, nothing to block
    }
  }
  if (unsupportedSchema) return unsupportedSchemaScreen();
  return null;
}
