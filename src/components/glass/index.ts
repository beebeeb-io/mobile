/**
 * Liquid Glass primitives (task 1311) — the floating CONTROL layer of the
 * iOS 26 redesign. Content belongs on the opaque grouped surfaces in
 * `theme.ts` (`surfaces` / `darkSurfaces`), never on glass.
 *
 * The material itself lives in `glass-recipe.ts`. That is the only file to
 * change to retune the look or to swap `expo-blur` for `expo-glass-effect`
 * once it has a stable SDK 57/58 release (see task 1311's recorded decision).
 *
 * A `__DEV__` gallery rendering every primitive over a photo and a plain
 * surface, in both schemes, lives at `src/screens/GlassGalleryScreen.tsx` —
 * reachable from Settings → Advanced → Diagnostics in a dev build.
 */

export { GlassSurface, resolveRadius, type GlassSurfaceProps } from './GlassSurface';
export { GlassCapsule, type GlassCapsuleProps } from './GlassCapsule';
export { GlassCircle, GLASS_CIRCLE_SIZES, type GlassCircleProps } from './GlassCircle';
export { GlassSheet, type GlassSheetProps } from './GlassSheet';
export {
  GlassSegment,
  type GlassSegmentOption,
  type GlassSegmentProps,
} from './GlassSegment';
export { ScrollEdgeBlur, type ScrollEdgeBlurProps } from './ScrollEdgeBlur';

export {
  BLUR_PX_AT_FULL_INTENSITY,
  GLASS_RADII,
  MODAL_SCRIM,
  SCROLL_EDGE,
  cssShadow,
  glassMaterial,
  intensityForCssBlur,
  modalScrim,
  scrollEdgeBandHeights,
  scrollEdgeBandIntensity,
  type GlassMaterial,
  type GlassRadiusName,
  type GlassScheme,
} from './glass-recipe';
