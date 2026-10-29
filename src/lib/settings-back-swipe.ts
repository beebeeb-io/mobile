// Task 2235 — iOS edge-swipe back for Settings sub-screens.
//
// Settings sub-screens (Account, Security, …) are local state inside
// `SettingsScreen`, not navigation routes, so iOS has no native interactive
// pop gesture to offer. The screen drives a Pan gesture itself and asks this
// pure helper whether the gesture should be treated as a "back" swipe.
//
// Kept pure (no react-native imports) so it is testable in the isolated Bun
// process without a native runtime.

/** Width of the strip along the left edge a back-swipe must start in. */
export const SETTINGS_BACK_EDGE_PX = 24;

/** Minimum horizontal travel, in points, that counts as a deliberate swipe. */
const MIN_SWIPE_DISTANCE_PX = 60;
/** Minimum travel as a fraction of screen width (tablets need a longer pull). */
const SWIPE_DISTANCE_RATIO = 0.18;
/** A flick faster than this completes the gesture without needing full travel. */
const MIN_SWIPE_VELOCITY_X = 500;

export interface SettingsBackSwipeInput {
  /** Gesture start point, in screen coordinates. */
  startX: number;
  /** Total horizontal translation; positive is rightward. */
  translationX: number;
  /** Horizontal velocity at gesture end, points/second. */
  velocityX: number;
  /** Window width, used to scale the distance threshold on large screens. */
  screenWidth: number;
}

/**
 * True when the gesture is a rightward swipe that started in the left edge
 * band and either travelled far enough (an absolute floor scaled by screen
 * width) or was fast enough to count as a flick.
 */
export function shouldCompleteSettingsBackSwipe(input: SettingsBackSwipeInput): boolean {
  const { startX, translationX, velocityX, screenWidth } = input;

  // Must begin inside the left edge band; mid-screen swipes are never "back".
  if (startX > SETTINGS_BACK_EDGE_PX) return false;

  // Only rightward travel can mean "back".
  if (translationX <= 0) return false;

  const distanceThreshold = Math.max(MIN_SWIPE_DISTANCE_PX, screenWidth * SWIPE_DISTANCE_RATIO);
  return translationX >= distanceThreshold || velocityX >= MIN_SWIPE_VELOCITY_X;
}
