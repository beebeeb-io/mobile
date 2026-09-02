/**
 * BBActionSheet — one reusable bottom action sheet for every iOS-style menu
 * (sort / "+" add / file-row actions). Task 0777, built to the approved design
 * spec: bottom-anchored, grabber, 56pt rows, 17pt labels, 22pt leading icons,
 * amber ONLY on the active row's icon + trailing checkmark, swipe-to-dismiss,
 * selection haptics, no "Cancel" row.
 *
 * Built on RN Animated + Modal + react-native-gesture-handler (reanimated isn't
 * in the tree). translateY is JS-driven so the swipe gesture can set it directly
 * without fighting a native-driver animation. Dismiss on: row select, scrim tap,
 * or swipe down past ~30% of the sheet height.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  PanGestureHandler,
  State,
  type PanGestureHandlerGestureEvent,
  type PanGestureHandlerStateChangeEvent,
} from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../lib/theme-context';
import { modalScrim } from './glass';
import { fonts, radii, shadows } from '../theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

export interface ActionSheetRow {
  key: string;
  label: string;
  icon: IoniconName;
  /** Active selection (sort menu) — amber icon + trailing checkmark + bold. */
  active?: boolean;
  /** Destructive (Delete) — red icon + label, medium-impact haptic. */
  destructive?: boolean;
  /** Stable id for Maestro/E2E (RN testID → iOS accessibilityIdentifier). */
  testID?: string;
  onPress: () => void;
}

export interface ActionSheetFileHeader {
  name: string;
  /** e.g. "1.2 MB · Jun 14". Rendered mono (it's machine data). */
  subtitle?: string;
  /** 40×40 thumbnail or a glyph element; falls back to a document glyph. */
  thumbnail?: React.ReactNode;
}

interface BBActionSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Centered caption (e.g. "Sort by"); omit for the "+" menu. */
  title?: string;
  /** File context header (row-actions menu); takes the place of `title`. */
  header?: ActionSheetFileHeader;
  rows: ActionSheetRow[];
}

const SCREEN_H = Dimensions.get('window').height;
const CLOSE_THRESHOLD = 0.3; // fraction of sheet height dragged → dismiss
const LEADING_INSET = 54; // 20 (pad) + 22 (icon) + 12 (gap) — separators align under the label

export function BBActionSheet({ visible, onClose, title, header, rows }: BBActionSheetProps) {
  const { colors: c, resolved } = useTheme();
  const insets = useSafeAreaInsets();

  const [rendered, setRendered] = useState(false);
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;
  const sheetH = useRef(0);

  const animateTo = useCallback(
    (to: number, then?: () => void) => {
      Animated.spring(translateY, {
        toValue: to,
        damping: 22,
        stiffness: 260,
        mass: 0.9,
        useNativeDriver: false,
      }).start(then);
    },
    [translateY],
  );

  // Open: mount then spring up. Close: spring down then unmount.
  useEffect(() => {
    if (visible) {
      setRendered(true);
      translateY.setValue(SCREEN_H);
      requestAnimationFrame(() => animateTo(0));
    } else if (rendered) {
      animateTo(SCREEN_H, () => setRendered(false));
    }
  }, [visible, rendered, translateY, animateTo]);

  // The veil itself is MODAL_SCRIM (alpha 0.5); this only fades it in as the
  // sheet springs up, so the token's own alpha is what lands at rest.
  const scrimOpacity = translateY.interpolate({
    inputRange: [0, SCREEN_H],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  // JS-driven drag: follow the finger downward only.
  const onGesture = useCallback(
    (e: PanGestureHandlerGestureEvent) => {
      translateY.setValue(Math.max(0, e.nativeEvent.translationY));
    },
    [translateY],
  );

  const onGestureStateChange = useCallback(
    (e: PanGestureHandlerStateChangeEvent) => {
      if (e.nativeEvent.state !== State.END) return;
      const dragged = e.nativeEvent.translationY;
      const fast = e.nativeEvent.velocityY > 800;
      if (dragged > sheetH.current * CLOSE_THRESHOLD || fast) onClose();
      else animateTo(0);
    },
    [animateTo, onClose],
  );

  const handleRow = useCallback(
    (row: ActionSheetRow) => {
      if (row.destructive) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      else Haptics.selectionAsync();
      onClose();
      // Fire after the close starts so the sheet doesn't linger over whatever
      // navigation/transition the action triggers.
      requestAnimationFrame(() => row.onPress());
    },
    [onClose],
  );

  if (!rendered) return null;

  return (
    <Modal transparent visible={rendered} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.fill}>
        <Animated.View
          style={[styles.scrim, { backgroundColor: modalScrim(resolved), opacity: scrimOpacity }]}
        >
          <Pressable style={styles.fill} onPress={onClose} accessibilityLabel="Dismiss menu" />
        </Animated.View>

        <PanGestureHandler onGestureEvent={onGesture} onHandlerStateChange={onGestureStateChange}>
          <Animated.View
            onLayout={(e) => { sheetH.current = e.nativeEvent.layout.height; }}
            style={[
              styles.sheet,
              shadows.lg,
              {
                backgroundColor: c.paper2,
                paddingBottom: Math.max(insets.bottom, 12),
                transform: [{ translateY }],
              },
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: c.line2 }]} />

            {header ? (
              <View style={[styles.header, { borderBottomColor: c.line }]}>
                <View style={[styles.thumb, { backgroundColor: c.line }]}>
                  {header.thumbnail ?? <Ionicons name="document-outline" size={20} color={c.ink3} />}
                </View>
                <View style={styles.headerText}>
                  <Text style={[styles.headerName, { color: c.ink }]} numberOfLines={1} ellipsizeMode="middle">
                    {header.name}
                  </Text>
                  {header.subtitle ? (
                    <Text style={[styles.headerSub, { color: c.ink3 }]} numberOfLines={1}>
                      {header.subtitle}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : title ? (
              <View style={[styles.titleWrap, { borderBottomColor: c.line }]}>
                <Text style={[styles.title, { color: c.ink3 }]}>{title}</Text>
              </View>
            ) : (
              <View style={{ height: 4 }} />
            )}

            {rows.map((row, i) => {
              const tint = row.destructive ? c.red : row.active ? c.amber : c.ink;
              const labelColor = row.destructive ? c.red : c.ink;
              return (
                <React.Fragment key={row.key}>
                  <Pressable
                    onPress={() => handleRow(row)}
                    testID={row.testID}
                    accessibilityRole="button"
                    accessibilityState={{ selected: row.active }}
                    style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.line }]}
                  >
                    <Ionicons name={row.icon} size={22} color={tint} style={styles.rowIcon} />
                    <Text
                      style={[styles.rowLabel, { color: labelColor, fontWeight: row.active ? '600' : '400' }]}
                      numberOfLines={1}
                    >
                      {row.label}
                    </Text>
                    {row.active ? <Ionicons name="checkmark" size={18} color={c.amber} /> : null}
                  </Pressable>
                  {i < rows.length - 1 ? (
                    <View style={[styles.separator, { backgroundColor: c.line }]} />
                  ) : null}
                </React.Fragment>
              );
            })}
          </Animated.View>
        </PanGestureHandler>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: 8,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 2.5, marginBottom: 12 },
  titleWrap: { paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: 'center' },
  title: { fontSize: 13, fontWeight: '600', letterSpacing: 0.3 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  headerText: { flex: 1, minWidth: 0 },
  headerName: { fontSize: 15, fontWeight: '600' },
  headerSub: { fontSize: 13, marginTop: 2, fontFamily: fonts.mono },
  row: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 20 },
  rowIcon: { marginRight: 12, width: 22, textAlign: 'center' },
  rowLabel: { flex: 1, fontSize: 17 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: LEADING_INSET },
});
