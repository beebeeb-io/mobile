/**
 * Task 1586 — the pure math behind the shared bottom sheet
 * (`src/components/sheet/BottomSheet.tsx`): which heights a sheet can rest
 * at, where a released drag lands, when it dismisses, and the rubber-band
 * past the top. No React / RN imports so bun can test it directly.
 *
 * Guus (build 221, verbatim): "Oh and sheets should be draggable by the
 * handle right. The top handle. So you can drop it more down/halfway etc"
 *
 * Coordinates: a sheet has a fixed layout height (its tallest detent) and is
 * moved by `translateY`. `translateY = 0` is the tallest detent; a detent of
 * height h rests at `sheetHeight - h`. Velocity is in points per second,
 * positive = moving DOWN (the gesture handler's `velocityY`).
 */

export type SheetDetentName = 'half' | 'default' | 'large';

/** Fractions of the available height. `default` is the 72% the Info sheet
 * has used since 1563; `large` is for long content (Info, Share). */
export const SHEET_DETENT_FRACTIONS: Readonly<Record<SheetDetentName, number>> = {
  half: 0.5,
  default: 0.72,
  large: 0.9,
};

/** Minimum gap kept between the sheet's top edge and the top safe-area inset. */
export const SHEET_TOP_GAP = 12;

/** A downward fling at or above this speed dismisses from any detent. */
export const SHEET_FLING_DISMISS_VELOCITY = 1800;

/** A release is projected this many seconds forward along its velocity
 * before picking the nearest detent — a flick moves a detent, a slow
 * release stays nearest to where the finger let go. */
export const SHEET_VELOCITY_PROJECTION_S = 0.12;

/** A (projected) visible height below this fraction of the SMALLEST detent
 * dismisses the sheet. */
export const SHEET_DISMISS_FRACTION = 0.6;

/** UIScrollView's rubber-band constant. */
export const SHEET_RUBBER_BAND_COEFFICIENT = 0.55;

export interface SheetDetent {
  name: SheetDetentName;
  /** Visible height in points when resting at this detent. */
  height: number;
}

/**
 * The detent heights for an available height (the container the sheet lives
 * in) and top inset, ascending, de-duplicated. Each is capped so the sheet
 * never reaches under the status bar / Dynamic Island.
 */
export function computeDetents(
  names: readonly SheetDetentName[],
  availableHeight: number,
  topInset: number,
): SheetDetent[] {
  const cap = Math.max(0, availableHeight - topInset - SHEET_TOP_GAP);
  const out: SheetDetent[] = [];
  for (const name of names) {
    const height = Math.round(Math.min(availableHeight * SHEET_DETENT_FRACTIONS[name], cap));
    if (height <= 0) continue;
    if (out.some((d) => d.height === height)) continue;
    out.push({ name, height });
  }
  return out.sort((a, b) => a.height - b.height);
}

/** The sheet's layout height: its tallest detent. */
export function sheetLayoutHeight(detents: readonly SheetDetent[]): number {
  return detents.length ? detents[detents.length - 1].height : 0;
}

/** translateY that rests the sheet at `detent`. */
export function translateForDetent(sheetHeight: number, detentHeight: number): number {
  return sheetHeight - detentHeight;
}

export type SheetSnap = { kind: 'detent'; index: number } | { kind: 'dismiss' };

/**
 * Where a released sheet goes.
 *
 * 1. A downward fling at or above `SHEET_FLING_DISMISS_VELOCITY` dismisses.
 * 2. The release point is projected along its velocity
 *    (`SHEET_VELOCITY_PROJECTION_S`).
 * 3. A projected height below `SHEET_DISMISS_FRACTION` of the smallest
 *    detent dismisses.
 * 4. Otherwise the detent nearest the projected height.
 *
 * `dismissible: false` turns 1 and 3 off (the sheet then always lands on a
 * detent).
 */
export function resolveSheetSnap(args: {
  visibleHeight: number;
  velocityY: number;
  detents: readonly SheetDetent[];
  dismissible?: boolean;
}): SheetSnap {
  const { visibleHeight, velocityY, detents, dismissible = true } = args;
  if (detents.length === 0) return { kind: 'dismiss' };
  if (dismissible && velocityY >= SHEET_FLING_DISMISS_VELOCITY) return { kind: 'dismiss' };
  const projected = visibleHeight - velocityY * SHEET_VELOCITY_PROJECTION_S;
  if (dismissible && projected < detents[0].height * SHEET_DISMISS_FRACTION) {
    return { kind: 'dismiss' };
  }
  let best = 0;
  let bestDistance = Infinity;
  detents.forEach((d, i) => {
    const distance = Math.abs(d.height - projected);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return { kind: 'detent', index: best };
}

/**
 * UIScrollView's rubber band: how far the sheet actually moves for
 * `overshoot` points of finger travel past its limit. Always < `dimension`,
 * ~0.55 × overshoot for small overshoots, flattening as it grows.
 */
export function rubberBand(
  overshoot: number,
  dimension: number,
  coefficient: number = SHEET_RUBBER_BAND_COEFFICIENT,
): number {
  if (overshoot <= 0 || dimension <= 0) return 0;
  return (1 - 1 / ((overshoot * coefficient) / dimension + 1)) * dimension;
}

/** The raw (finger) translateY → the displayed translateY: unchanged within
 * [0, ∞), rubber-banded above the tallest detent (negative values). */
export function displayedTranslate(raw: number, sheetHeight: number): number {
  return raw >= 0 ? raw : -rubberBand(-raw, sheetHeight);
}

/**
 * An `Animated.interpolate` config applying `displayedTranslate` natively:
 * a piecewise-linear sample of the rubber band for negative input, identity
 * from 0 down to `closedTranslate`, clamped at both ends.
 */
export function rubberBandInterpolation(
  sheetHeight: number,
  closedTranslate: number,
): { inputRange: number[]; outputRange: number[] } {
  const overshoots = [4000, 2000, 1200, 800, 500, 300, 200, 120, 60, 30, 10];
  const inputRange = [...overshoots.map((o) => -o), 0, Math.max(closedTranslate, 1)];
  const outputRange = inputRange.map((x) => displayedTranslate(x, sheetHeight));
  return { inputRange, outputRange };
}

/**
 * VoiceOver's adjustable handle: swipe up (`increment`) grows the sheet one
 * detent, swipe down (`decrement`) shrinks it; decrementing below the
 * smallest detent dismisses (when dismissible), incrementing past the
 * largest stays put.
 */
export function adjustDetent(
  index: number,
  action: 'increment' | 'decrement',
  count: number,
  dismissible = true,
): SheetSnap {
  if (count <= 0) return { kind: 'dismiss' };
  if (action === 'increment') return { kind: 'detent', index: Math.min(index + 1, count - 1) };
  if (index <= 0) return dismissible ? { kind: 'dismiss' } : { kind: 'detent', index: 0 };
  return { kind: 'detent', index: index - 1 };
}

/** Spoken value of the handle ("Half height" etc). */
export function detentAccessibilityValue(name: SheetDetentName): string {
  switch (name) {
    case 'half':
      return 'Half height';
    case 'large':
      return 'Full height';
    default:
      return 'Default height';
  }
}

// ---------------------------------------------------------------------------
// Gesture + visibility decisions (1586 review fixes). Pure so they are
// tested as behaviour, not as source text; `BottomSheet.tsx` only applies
// the returned effect.
// ---------------------------------------------------------------------------

/** The content pan's hand-over state across one gesture. */
export interface ContentPanState {
  /** The sheet currently follows the finger. */
  dragging: boolean;
  /** A hand-over happened at some point in THIS gesture (it stopped the
   * spring and gave the content frame its full height), even if the finger
   * has since gone back above the start and the scroll view took over. */
  handedOff: boolean;
  /** translationY at the (latest) hand-over. */
  handoffAt: number;
}

export const CONTENT_PAN_IDLE: ContentPanState = { dragging: false, handedOff: false, handoffAt: 0 };

export type ContentPanMove =
  /** Nothing for the sheet to do (the scroll view owns the gesture). */
  | { kind: 'none' }
  /** Hand-over now: stop the spring, full content frame, then follow `drag`. */
  | { kind: 'handoff'; drag: number }
  /** Follow the finger. */
  | { kind: 'drag'; drag: number }
  /** Back above the hand-over point: the sheet's finger offset returns to 0. */
  | { kind: 'home' };

/** A content-pan move while ACTIVE. */
export function contentPanMove(
  state: ContentPanState,
  translationY: number,
  scrollY: number,
): { state: ContentPanState; effect: ContentPanMove } {
  let next = state;
  let handoff = false;
  if (!next.dragging) {
    if (scrollY > 0.5 || translationY <= 0) return { state: next, effect: { kind: 'none' } };
    next = { dragging: true, handedOff: true, handoffAt: translationY };
    handoff = true;
  }
  const d = translationY - next.handoffAt;
  if (d < 0) return { state: { ...next, dragging: false }, effect: { kind: 'home' } };
  return { state: next, effect: handoff ? { kind: 'handoff', drag: d } : { kind: 'drag', drag: d } };
}

export type ContentPanRelease =
  /** The scroll view owned the whole gesture — nothing to do. */
  | { kind: 'none' }
  /** The sheet was following the finger: resolve the release (detent / dismiss). */
  | { kind: 'finish'; translation: number }
  /** A hand-over happened but was reversed before release: the spring was
   * stopped and the content frame un-padded, so spring back to the current
   * detent (which also restores the padding). Review P1 #1. */
  | { kind: 'reseat' };

/** The content pan left ACTIVE (end / cancel / fail). */
export function contentPanRelease(state: ContentPanState, translationY: number): ContentPanRelease {
  if (state.dragging) return { kind: 'finish', translation: translationY - state.handoffAt };
  if (state.handedOff) return { kind: 'reseat' };
  return { kind: 'none' };
}

export type SheetVisibilityAction =
  | { kind: 'none' }
  /** Opening: jump to the initial detent. */
  | { kind: 'open' }
  /** Spring to closed; `notifyDismissed` = call `onDismissed` when it lands. */
  | { kind: 'close'; velocity: number; notifyDismissed: boolean }
  /** Spring to the current detent (a re-layout, or a refused dismiss). */
  | { kind: 'reseat' };

/**
 * What the sheet does after a render, from `visible` and what it last did.
 *
 * - `pendingDismissVelocity`: a drag / fling asked the parent to close
 *   (`onRequestClose`) and the sheet has NOT moved yet. If the parent flips
 *   `visible` the sheet closes with that velocity; if it refuses (`visible`
 *   stays true) the sheet springs back to its detent — no invisible layer
 *   left over the screen (review #3).
 * - `onDismissed` fires only for a close of a sheet that was open (or whose
 *   close from open was still in flight): a sheet mounted closed, or
 *   re-laid-out while closed, never reports a dismissal (review #4).
 */
export function resolveVisibilityAction(s: {
  visible: boolean;
  wasVisible: boolean;
  /** An open→closed close has started and its `onDismissed` has not fired. */
  closeInFlight: boolean;
  lastTarget: number | null;
  target: number;
  pendingDismissVelocity: number | null;
}): SheetVisibilityAction {
  if (s.visible && !s.wasVisible) return { kind: 'open' };
  if (!s.visible) {
    // Already heading to / parked at this closed position.
    if (!s.wasVisible && s.lastTarget === s.target) return { kind: 'none' };
    const fromOpen = s.wasVisible || s.closeInFlight;
    return {
      kind: 'close',
      velocity: s.wasVisible ? s.pendingDismissVelocity ?? 0 : 0,
      notifyDismissed: fromOpen,
    };
  }
  if (s.pendingDismissVelocity != null) return { kind: 'reseat' };
  if (s.lastTarget === s.target) return { kind: 'none' };
  return { kind: 'reseat' };
}
