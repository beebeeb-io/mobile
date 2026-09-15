/**
 * Guarded probe for `expo-glass-effect`'s `isLiquidGlassAvailable()` (task 1409).
 *
 * The library's own `isLiquidGlassAvailable()` calls `requireNativeModule('ExpoGlassEffect')`
 * unguarded and THROWS `Cannot find native module 'ExpoGlassEffect'` when the native module
 * isn't linked into the running binary — true for any dev client built BEFORE the dependency
 * was added (task 1308c), or any other binary/OTA-bundle skew. Production builds always link
 * the module (it ships via CocoaPods), so this is a resilience issue for stale dev clients, not
 * a shipped crash path today — but a decorative material must never be able to take down the
 * whole tree (found by lane eng-1405: it blanked the unauthenticated LoginScreen).
 *
 * `GlassSurface` calls this instead of importing `isLiquidGlassAvailable` directly. Both
 * "unavailable" and "throws" fall back to the existing `BlurView` path; there is no behaviour
 * change when the module IS present and working.
 */
import { isLiquidGlassAvailable } from 'expo-glass-effect';

let cached: boolean | undefined;

export function isGlassAvailable(): boolean {
  if (cached === undefined) {
    try {
      cached = isLiquidGlassAvailable();
    } catch {
      cached = false;
    }
  }
  return cached;
}
