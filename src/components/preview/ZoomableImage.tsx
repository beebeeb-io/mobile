/**
 * Task 1579 — pinch / pan / double-tap zoom for the full-screen preview.
 *
 * No new native dependency: on iOS this is a plain RN `ScrollView` with
 * `minimumZoomScale`/`maximumZoomScale` (UIScrollView's own pinch + pan,
 * rubber-banding and deceleration), and a double-tap calls
 * `scrollResponderZoomTo` (UIScrollView `zoomToRect:`) with the rect from
 * `doubleTapZoomRect` in `src/lib/preview-zoom.ts`.
 *
 * Taps are read from RAW `onTouchStart`/`onTouchEnd` — deliberately not a
 * `Pressable`/responder: the photo pager's own comment in PreviewScreen
 * documents (bisected on-device) that a JS responder around the paging
 * FlatList swallows every swipe, and a JS responder here would do the same
 * to UIScrollView's native pinch. Both raw events are stopped from
 * propagating, so the pager's own tap-to-toggle-chrome handler never sees
 * a tap on a zoomable page; this component owns it instead and reports it
 * through `onSingleTap`, delayed by the double-tap window so a double-tap
 * zooms WITHOUT also flickering the chrome twice.
 *
 * Android: ScrollView zoom props are iOS-only, so there the content renders
 * unzoomable (single tap still reaches `onSingleTap`). The iOS app is the
 * shipping target (build 219); an Android zoom is a separate task.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  DOUBLE_TAP_MAX_DELAY_MS,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  clampZoomScale,
  doubleTapZoomRect,
  isDoubleTap,
  isTapGesture,
  isZoomed,
  shouldBlockPaging,
  type TapSample,
} from '../../lib/preview-zoom';

export interface ZoomableImageProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Fired when the content crosses between 1x and zoomed (either way). */
  onZoomChange?: (zoomed: boolean) => void;
  /** A single tap that was not the first half of a double-tap. */
  onSingleTap?: () => void;
  /**
   * Any change to this value snaps the zoom back to 1x without animation —
   * PreviewScreen passes the page's `isCurrent`, so paging away resets it.
   */
  resetSignal?: unknown;
  testID?: string;
}

const ZOOM_SUPPORTED = Platform.OS === 'ios';

export function ZoomableImage({
  children,
  style,
  onZoomChange,
  onSingleTap,
  resetSignal,
  testID,
}: ZoomableImageProps) {
  const scrollRef = useRef<ScrollView>(null);
  const wrapRef = useRef<View>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const scaleRef = useRef(MIN_ZOOM_SCALE);
  const originRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const touchStartRef = useRef<TapSample | null>(null);
  const multiTouchRef = useRef(false);
  const lastTapRef = useRef<TapSample | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest callbacks in refs so the effects below don't re-run per render.
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  const onSingleTapRef = useRef(onSingleTap);
  onSingleTapRef.current = onSingleTap;

  const zoomedRef = useRef(false);
  const setZoomedState = useCallback((next: boolean) => {
    if (zoomedRef.current === next) return;
    zoomedRef.current = next;
    setZoomed(next);
    onZoomChangeRef.current?.(next);
  }, []);

  const clearSingleTapTimer = useCallback(() => {
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
      singleTapTimerRef.current = null;
    }
  }, []);

  const zoomToFull = useCallback((animated: boolean) => {
    if (!viewport) return;
    scrollRef.current?.scrollResponderZoomTo({
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
      animated,
    });
  }, [viewport]);

  // Paging away (or any other reset signal) snaps back to 1x.
  const firstResetRef = useRef(true);
  useEffect(() => {
    if (firstResetRef.current) {
      firstResetRef.current = false;
      return;
    }
    lastTapRef.current = null;
    clearSingleTapTimer();
    if (isZoomed(scaleRef.current)) zoomToFull(false);
    scaleRef.current = MIN_ZOOM_SCALE;
    setZoomedState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  // Unmounting while zoomed must not leave the pager locked.
  useEffect(() => () => {
    clearSingleTapTimer();
    if (zoomedRef.current) onZoomChangeRef.current?.(false);
  }, [clearSingleTapTimer]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setViewport((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const scale = clampZoomScale(e.nativeEvent.zoomScale ?? MIN_ZOOM_SCALE);
    scaleRef.current = scale;
    setZoomedState(shouldBlockPaging(scale));
  }, [setZoomedState]);

  const handleTouchStart = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation();
    const { pageX, pageY, touches } = e.nativeEvent;
    if ((touches?.length ?? 1) > 1) {
      multiTouchRef.current = true;
      return;
    }
    multiTouchRef.current = false;
    touchStartRef.current = { x: pageX, y: pageY, t: Date.now() };
    // Page-to-content offset for the double-tap point (the pager moves this
    // view horizontally, so it is re-read per touch, not cached at layout).
    wrapRef.current?.measureInWindow((x, y) => {
      originRef.current = { x, y };
    });
  }, []);

  const handleTouchEnd = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation();
    const { pageX, pageY, touches } = e.nativeEvent;
    if ((touches?.length ?? 0) > 0) return; // other fingers still down
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const wasMulti = multiTouchRef.current;
    multiTouchRef.current = false;
    if (!start || wasMulti) return;
    const tap: TapSample = { x: pageX, y: pageY, t: Date.now() };
    if (!isTapGesture(start, tap)) {
      lastTapRef.current = null;
      return;
    }
    if (ZOOM_SUPPORTED && viewport && isDoubleTap(lastTapRef.current, tap)) {
      lastTapRef.current = null;
      clearSingleTapTimer();
      const rect = doubleTapZoomRect({
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        tapX: tap.x - originRef.current.x,
        tapY: tap.y - originRef.current.y,
        currentScale: scaleRef.current,
      });
      scrollRef.current?.scrollResponderZoomTo({ ...rect, animated: true });
      return;
    }
    lastTapRef.current = tap;
    clearSingleTapTimer();
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null;
      lastTapRef.current = null;
      onSingleTapRef.current?.();
    }, DOUBLE_TAP_MAX_DELAY_MS);
  }, [clearSingleTapTimer, viewport]);

  const handleTouchCancel = useCallback((e: GestureResponderEvent) => {
    e.stopPropagation();
    touchStartRef.current = null;
    multiTouchRef.current = false;
  }, []);

  const contentStyle = viewport
    ? { width: viewport.width, height: viewport.height }
    : styles.fill;

  return (
    <View
      ref={wrapRef}
      style={[styles.fill, style]}
      onLayout={handleLayout}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchCancel}
      testID={testID}
    >
      {ZOOM_SUPPORTED ? (
        <ScrollView
          ref={scrollRef}
          style={styles.fill}
          contentContainerStyle={viewport ? undefined : styles.grow}
          minimumZoomScale={MIN_ZOOM_SCALE}
          maximumZoomScale={MAX_ZOOM_SCALE}
          pinchGestureEnabled
          bouncesZoom
          // At 1x the content is exactly the viewport and must not scroll or
          // bounce at all — otherwise this UIScrollView's pan would begin and
          // steal the pager's horizontal swipe / the vertical gestures.
          bounces={zoomed}
          alwaysBounceHorizontal={false}
          alwaysBounceVertical={false}
          centerContent
          scrollsToTop={false}
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={handleScroll}
          decelerationRate="fast"
          accessibilityHint="Pinch or double-tap to zoom"
        >
          <View style={contentStyle}>{children}</View>
        </ScrollView>
      ) : (
        <View style={styles.fill}>{children}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, alignSelf: 'stretch' },
  grow: { flexGrow: 1 },
});

export default ZoomableImage;
