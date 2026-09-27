/**
 * BottomSheet — the ONE bottom sheet every partial-height sheet in the app
 * renders through (task 1586).
 *
 * Guus, build 221 (verbatim): "make sure that every sheet going from bottom
 * to 70%-isch, is full width" and "Oh and sheets should be draggable by the
 * handle right. The top handle. So you can drop it more down/halfway etc".
 *
 * Geometry (the Info sheet's #137 fix, now shared): full width, attached to
 * the bottom edge, top corners only at `GLASS_RADII.sheet` (38), the
 * home-indicator inset as padding INSIDE the sheet.
 *
 * Drag: the handle row + the optional `header` are the pan target. The
 * sheet rests at detents (`src/lib/sheet-detents.ts` — half ~50 %, default
 * ~72 %, large ~90 %), a release lands on the nearest one by position +
 * velocity, a drag far enough down or a fast downward fling dismisses, and
 * dragging past the tallest detent is rubber-banded. Content inside
 * `BottomSheetScrollView` scrolls at every detent; pulling down while it is
 * scrolled to the top hands the drag to the sheet (the standard iOS sheet
 * behaviour). VoiceOver: the handle is an adjustable element — swipe up /
 * down changes the detent, below the smallest dismisses.
 *
 * Built on RN Animated + react-native-gesture-handler (Reanimated is not in
 * the tree). The sheet's layout height is its tallest detent and it moves by
 * `translateY` on the native driver: `base` (the resting position, sprung)
 * + `drag` (the finger, a native `Animated.event` on the handle). At a
 * smaller detent the sheet's lower part is off screen, so once it settles
 * `restHidden` pads the content frame by that much — the scroll view's last
 * rows stay reachable at the half detent.
 */

import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {
  PanGestureHandler,
  ScrollView as GestureScrollView,
  State,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GLASS_RADII, modalScrim } from '../glass';
import { shadows } from '../../theme';
import { useTheme } from '../../lib/theme-context';
import {
  CONTENT_PAN_IDLE,
  adjustDetent,
  computeDetents,
  contentPanMove,
  contentPanRelease,
  detentAccessibilityValue,
  displayedTranslate,
  resolveSheetSnap,
  resolveVisibilityAction,
  rubberBandInterpolation,
  sheetLayoutHeight,
  translateForDetent,
  type ContentPanState,
  type SheetDetentName,
  type SheetSnap,
} from '../../lib/sheet-detents';

const SPRING = { damping: 26, stiffness: 240, mass: 0.9 } as const;
/** How far below the screen a closed sheet parks (clears its shadow). */
const CLOSED_EXTRA = 40;

export interface BottomSheetProps {
  visible: boolean;
  /** Scrim tap, a dismissing drag/fling, VoiceOver escape. The parent flips
   * `visible` to false (or refuses). */
  onRequestClose: () => void;
  /** After the close animation has finished (a routed sheet pops here). */
  onDismissed?: () => void;
  /** Resting heights; default half + default + large. */
  detents?: readonly SheetDetentName[];
  /** Where the sheet opens; default `'default'` (else the tallest given). */
  initialDetent?: SheetDetentName;
  /** Stacking slot of the whole layer (scrim + sheet) inside its parent. */
  zIndex?: number;
  /** Distance from the top of the container the sheet's top edge never
   * crosses; default the top safe-area inset. A sheet under floating chrome
   * (the preview's close / title / ⋯ row) passes the chrome's bottom. */
  topClearance?: number;
  /** Rendered under the handle and draggable with it (e.g. a file row). */
  header?: React.ReactNode;
  /** Keep the sheet above the software keyboard (and grow it to its
   * tallest detent while the keyboard is up). */
  avoidKeyboard?: boolean;
  /** Default `c.paper` — sheets are a content surface, not glass. */
  backgroundColor?: string;
  /** Padding etc. for the area below the handle (header + children). */
  contentStyle?: StyleProp<ViewStyle>;
  handleAccessibilityLabel?: string;
  scrimAccessibilityLabel?: string;
  testID?: string;
  /** The whole layer (scrim + sheet); default `${testID}-layer`. */
  layerTestID?: string;
  scrimTestID?: string;
  handleTestID?: string;
  children?: React.ReactNode;
}

interface SheetContextValue {
  contentPanRef: React.RefObject<PanGestureHandler | null>;
  scrollYRef: React.MutableRefObject<number>;
  onContentGesture: (e: PanGestureHandlerGestureEvent) => void;
  onContentStateChange: (e: PanGestureHandlerStateChangeEvent) => void;
}

const SheetContext = createContext<SheetContextValue | null>(null);

/** The inner-safe-area padding: the home indicator never covers content. */
export function sheetSafeBottom(insetBottom: number): number {
  return Math.max(insetBottom, 16);
}

export function BottomSheet({
  visible,
  onRequestClose,
  onDismissed,
  detents: detentNames = ['half', 'default', 'large'],
  initialDetent = 'default',
  zIndex,
  topClearance,
  header,
  avoidKeyboard = false,
  backgroundColor,
  contentStyle,
  handleAccessibilityLabel = 'Sheet grabber',
  scrimAccessibilityLabel = 'Close',
  testID,
  layerTestID,
  scrimTestID,
  handleTestID,
  children,
}: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const { colors: c, resolved } = useTheme();

  const [containerHeight, setContainerHeight] = useState(() => Dimensions.get('window').height);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const namesKey = detentNames.join(',');
  const detents = useMemo(
    () => computeDetents(detentNames, containerHeight - keyboardHeight, topClearance ?? insets.top),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [namesKey, containerHeight, keyboardHeight, insets.top, topClearance],
  );
  const sheetHeight = sheetLayoutHeight(detents);
  const closedY = sheetHeight + keyboardHeight + CLOSED_EXTRA;

  const initialIndex = Math.max(
    0,
    detents.findIndex((d) => d.name === initialDetent) >= 0
      ? detents.findIndex((d) => d.name === initialDetent)
      : detents.length - 1,
  );
  const [index, setIndex] = useState(initialIndex);
  const indexRef = useRef(index);
  indexRef.current = Math.min(index, Math.max(0, detents.length - 1));
  const safeIndex = indexRef.current;

  const restFor = useCallback(
    (i: number) => translateForDetent(sheetHeight, detents[i]?.height ?? sheetHeight),
    [detents, sheetHeight],
  );

  // How much of the sheet is below the screen at rest — padded out of the
  // content frame so a scroll view can reach its end at every detent.
  const [restHidden, setRestHidden] = useState(() => restFor(initialIndex));

  const base = useRef(new Animated.Value(closedY)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const baseStartRef = useRef(closedY);
  const lastTargetRef = useRef<number | null>(null);
  const onDismissedRef = useRef(onDismissed);
  onDismissedRef.current = onDismissed;

  const animateTo = useCallback(
    (target: number, velocity = 0, done?: (finished: boolean) => void) => {
      lastTargetRef.current = target;
      Animated.spring(base, {
        toValue: target,
        velocity,
        ...SPRING,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) {
          baseStartRef.current = target;
          setRestHidden(target >= closedY ? 0 : target);
        }
        done?.(finished);
      });
    },
    [base, closedY],
  );

  // An open→closed close whose `onDismissed` has not fired yet (survives a
  // re-layout that restarts the close spring).
  const closeInFlightRef = useRef(false);
  const close = useCallback(
    (velocity: number, notifyDismissed: boolean) => {
      closeInFlightRef.current = notifyDismissed;
      animateTo(closedY, velocity, (finished) => {
        if (finished && notifyDismissed) {
          closeInFlightRef.current = false;
          onDismissedRef.current?.();
        }
      });
    },
    [animateTo, closedY],
  );

  // A drag / fling asked the parent to close; the sheet waits for its answer
  // (review #3). `dismissRequest` re-runs the effect below in the same render
  // as the parent's `visible` flip (React batches both updates).
  const pendingDismissVelocityRef = useRef<number | null>(null);
  const [dismissRequest, setDismissRequest] = useState(0);

  // Open / close / re-layout: rest where `visible` + the current detent say.
  const target = visible ? restFor(safeIndex) : closedY;
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    const action = resolveVisibilityAction({
      visible,
      wasVisible: wasVisibleRef.current,
      closeInFlight: closeInFlightRef.current,
      lastTarget: lastTargetRef.current,
      target,
      pendingDismissVelocity: pendingDismissVelocityRef.current,
    });
    wasVisibleRef.current = visible;
    pendingDismissVelocityRef.current = null;
    switch (action.kind) {
      case 'open': {
        // Every open starts at the initial detent.
        closeInFlightRef.current = false;
        indexRef.current = initialIndex;
        setIndex(initialIndex);
        const openTarget = restFor(initialIndex);
        setRestHidden(openTarget);
        animateTo(openTarget);
        return;
      }
      case 'close':
        close(action.velocity, action.notifyDismissed);
        return;
      case 'reseat':
        setRestHidden((h) => Math.min(h, target));
        animateTo(target);
        return;
      default:
        return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, target, dismissRequest]);

  // Keyboard: sit on top of it and grow to the tallest detent.
  useEffect(() => {
    if (!avoidKeyboard) return;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, (e) => {
      setKeyboardHeight(Math.max(0, e.endCoordinates.height));
      setIndex(Number.MAX_SAFE_INTEGER); // clamped to the tallest detent
    });
    const hide = Keyboard.addListener(hideEvt, () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [avoidKeyboard]);

  // ---- Release → detent or dismiss ----
  const finishDrag = useCallback(
    (translation: number, velocityY: number) => {
      const raw = baseStartRef.current + translation;
      const shown = sheetHeight - displayedTranslate(raw, sheetHeight);
      const snap: SheetSnap = resolveSheetSnap({ visibleHeight: shown, velocityY, detents });
      // Flatten the finger into the resting value; both land in one native batch.
      base.setValue(raw);
      drag.setValue(0);
      if (snap.kind === 'dismiss') {
        // Only ASK: the parent's `visible` flip closes the sheet with this
        // velocity; a refusal springs it back (review #3).
        pendingDismissVelocityRef.current = velocityY;
        setDismissRequest((n) => n + 1);
        onRequestClose();
        return;
      }
      indexRef.current = snap.index;
      setIndex(snap.index);
      animateTo(restFor(snap.index), velocityY);
    },
    [animateTo, base, detents, drag, onRequestClose, restFor, sheetHeight],
  );

  const beginDrag = useCallback(() => {
    // Any drag may go up, so the content frame gets its full height now
    // (it only grows downward, off screen — nothing visible moves).
    setRestHidden(0);
    base.stopAnimation((v) => {
      baseStartRef.current = v;
    });
  }, [base]);

  // Handle: the finger drives `drag` on the native driver.
  const onHandleGesture = useMemo(
    () => Animated.event([{ nativeEvent: { translationY: drag } }], { useNativeDriver: true }),
    [drag],
  );
  const onHandleStateChange = useCallback(
    (e: PanGestureHandlerStateChangeEvent) => {
      const { state, oldState, translationY, velocityY } = e.nativeEvent;
      // Only a gesture that actually activates stops a running spring — a
      // touch that BEGAN and failed (a tap on the handle) must not freeze the
      // sheet between detents.
      if (state === State.ACTIVE) beginDrag();
      if (oldState === State.ACTIVE) finishDrag(translationY, velocityY);
    },
    [beginDrag, finishDrag],
  );

  // Content: hand over from the scroll view when it is at its top.
  const contentPanRef = useRef<PanGestureHandler | null>(null);
  const scrollYRef = useRef(0);
  // The hand-over decisions are pure (`contentPanMove` / `contentPanRelease`
  // in sheet-detents.ts); this only applies them.
  const contentPanStateRef = useRef<ContentPanState>(CONTENT_PAN_IDLE);
  const onContentGesture = useCallback(
    (e: PanGestureHandlerGestureEvent) => {
      const { state, effect } = contentPanMove(
        contentPanStateRef.current,
        e.nativeEvent.translationY,
        scrollYRef.current,
      );
      contentPanStateRef.current = state;
      switch (effect.kind) {
        case 'handoff':
          beginDrag();
          drag.setValue(effect.drag);
          return;
        case 'drag':
          drag.setValue(effect.drag);
          return;
        case 'home':
          // Back above where the hand-over started: the scroll view takes the
          // rest of the gesture; the release re-seats the sheet.
          drag.setValue(0);
          return;
        default:
          return;
      }
    },
    [beginDrag, drag],
  );
  const onContentStateChange = useCallback(
    (e: PanGestureHandlerStateChangeEvent) => {
      const { state, oldState, translationY, velocityY } = e.nativeEvent;
      if (state === State.BEGAN) contentPanStateRef.current = CONTENT_PAN_IDLE;
      if (oldState !== State.ACTIVE) return;
      const release = contentPanRelease(contentPanStateRef.current, translationY);
      contentPanStateRef.current = CONTENT_PAN_IDLE;
      if (release.kind === 'finish') {
        finishDrag(release.translation, velocityY);
      } else if (release.kind === 'reseat') {
        // Review P1 #1: a reversed pull stopped the spring and un-padded the
        // content frame — spring back to the detent (restores the padding).
        animateTo(restFor(indexRef.current));
      }
    },
    [animateTo, finishDrag, restFor],
  );

  const contextValue = useMemo<SheetContextValue>(
    () => ({ contentPanRef, scrollYRef, onContentGesture, onContentStateChange }),
    [onContentGesture, onContentStateChange],
  );

  // ---- VoiceOver ----
  const onHandleAccessibilityAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const name = e.nativeEvent.actionName;
      if (name === 'escape') {
        onRequestClose();
        return;
      }
      if (name !== 'increment' && name !== 'decrement') return;
      const snap = adjustDetent(indexRef.current, name, detents.length);
      if (snap.kind === 'dismiss') {
        onRequestClose();
        return;
      }
      indexRef.current = snap.index;
      setIndex(snap.index);
    },
    [detents.length, onRequestClose],
  );

  // ---- Drawing ----
  const pos = useMemo(() => Animated.add(base, drag), [base, drag]);
  const translateY = useMemo(
    () => pos.interpolate({ ...rubberBandInterpolation(sheetHeight, closedY), extrapolate: 'clamp' }),
    [pos, sheetHeight, closedY],
  );
  const smallest = detents[0]?.height ?? sheetHeight;
  const scrimOpacity = useMemo(
    () =>
      pos.interpolate({
        inputRange: [sheetHeight - smallest, Math.max(closedY, sheetHeight - smallest + 1)],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
    [pos, sheetHeight, smallest, closedY],
  );

  const safeBottom = sheetSafeBottom(insets.bottom);
  const bottomPad = keyboardHeight > 0 ? 8 : safeBottom;
  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0) setContainerHeight(h);
  }, []);

  return (
    <View
      style={[StyleSheet.absoluteFill, zIndex != null ? { zIndex } : null]}
      pointerEvents={visible ? 'auto' : 'none'}
      onLayout={onRootLayout}
      testID={layerTestID ?? (testID ? `${testID}-layer` : undefined)}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: scrimOpacity }]}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: modalScrim(resolved) }]}
          onPress={onRequestClose}
          accessibilityRole="button"
          accessibilityLabel={scrimAccessibilityLabel}
          testID={scrimTestID}
        />
      </Animated.View>

      <Animated.View
        style={[
          sheetStyles.sheet,
          {
            height: sheetHeight,
            bottom: keyboardHeight,
            backgroundColor: backgroundColor ?? c.paper,
            paddingBottom: bottomPad + restHidden,
            transform: [{ translateY }],
          },
        ]}
        testID={testID}
        // VoiceOver stays inside the sheet; the two-finger Z closes it from
        // any element (review #9).
        accessibilityViewIsModal
        onAccessibilityEscape={onRequestClose}
      >
        {/* Paper below the bottom edge: an over-drag past the tallest detent
            lifts the sheet, and this fills the gap instead of scrim (review #2). */}
        <View
          pointerEvents="none"
          style={[sheetStyles.underfill, { height: sheetHeight, backgroundColor: backgroundColor ?? c.paper }]}
        />
        <PanGestureHandler
          onGestureEvent={onHandleGesture}
          onHandlerStateChange={onHandleStateChange}
          // ±10: a tap on a header button that drifts a few points is still
          // a tap (review #5).
          activeOffsetY={[-10, 10]}
        >
          <Animated.View>
            <View
              style={sheetStyles.handleRow}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={handleAccessibilityLabel}
              accessibilityHint="Swipe up or down to resize the sheet."
              accessibilityValue={{ text: detentAccessibilityValue(detents[safeIndex]?.name ?? 'default') }}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }, { name: 'escape' }]}
              onAccessibilityAction={onHandleAccessibilityAction}
              testID={handleTestID ?? (testID ? `${testID}-handle` : undefined)}
            >
              <View style={[sheetStyles.grabber, { backgroundColor: c.line2 }]} />
            </View>
            {header ? <View style={contentStyle}>{header}</View> : null}
          </Animated.View>
        </PanGestureHandler>

        <SheetContext.Provider value={contextValue}>
          <View style={[sheetStyles.body, contentStyle]}>{children}</View>
        </SheetContext.Provider>
      </Animated.View>
    </View>
  );
}

/**
 * The sheet's scroll view. Scrolls at every detent; a pull-down while it
 * is at its top drags the sheet. Outside a `BottomSheet` it is a plain
 * (gesture-handler) ScrollView.
 */
export const BottomSheetScrollView = forwardRef<React.ElementRef<typeof GestureScrollView>, ScrollViewProps>(
  function BottomSheetScrollView({ onScroll, style, ...rest }, ref) {
    const ctx = useContext(SheetContext);
    const innerRef = useRef<React.ElementRef<typeof GestureScrollView>>(null);
    useImperativeHandle(ref, () => innerRef.current as React.ElementRef<typeof GestureScrollView>);

    const handleScroll = useCallback(
      (e: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (ctx) ctx.scrollYRef.current = e.nativeEvent.contentOffset.y;
        onScroll?.(e);
      },
      [ctx, onScroll],
    );

    if (!ctx) {
      return <GestureScrollView ref={innerRef} style={style} onScroll={onScroll} {...rest} />;
    }
    return (
      <PanGestureHandler
        ref={ctx.contentPanRef}
        simultaneousHandlers={innerRef}
        onGestureEvent={ctx.onContentGesture}
        onHandlerStateChange={ctx.onContentStateChange}
        activeOffsetY={[-6, 6]}
        failOffsetX={[-24, 24]}
      >
        <Animated.View style={sheetStyles.scrollWrap}>
          <GestureScrollView
            ref={innerRef}
            simultaneousHandlers={ctx.contentPanRef}
            style={style}
            // A pull at the top moves the sheet, not an overscroll.
            bounces={false}
            overScrollMode="never"
            scrollEventThrottle={16}
            onScroll={handleScroll}
            {...rest}
          />
        </Animated.View>
      </PanGestureHandler>
    );
  },
);

// Full width, attached to the bottom edge, top corners only — the Info
// sheet's #137 geometry (design/preview-redesign-ios.html section 03,
// `.sheet2{left:0;right:0;bottom:0;border-radius:9cqw 9cqw 0 0}`), shared by
// every sheet since 1586. `bottom` is overridden only by the keyboard height.
export const sheetStyles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: GLASS_RADII.sheet,
    borderTopRightRadius: GLASS_RADII.sheet,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    ...shadows.lg,
  },
  handleRow: { alignItems: 'center', paddingTop: 8, paddingBottom: 10, minHeight: 28 },
  grabber: { width: 36, height: 5, borderRadius: 2.5 },
  body: { flex: 1 },
  underfill: { position: 'absolute', top: '100%', left: 0, right: 0 },
  scrollWrap: { flex: 1 },
});

export default BottomSheet;
