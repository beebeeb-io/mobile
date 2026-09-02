import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

/**
 * The keyboard height term for a floating element's own bottom padding —
 * `useKeyboardLayoutAnimation`'s `keyboardHeight` is exactly this value
 * (0 once the keyboard is dismissed).
 *
 * 1338b MAJOR 2, reopened: `KeyboardAvoidingView` lifts the search stack
 * above the keyboard, but a SIBLING FlatList has no idea the keyboard
 * exists — its `paddingBottom` only ever summed the stack's own measured
 * height plus a fixed gap. With the keyboard up, the space the list must
 * actually clear is bar + keyboard, not just the bar, so the last row(s)
 * stayed permanently behind the capsule row no matter how far the list
 * scrolled — proven on-device with a short (6-item) filtered list where the
 * crop above the search bar was byte-identical from the very first render
 * through 15 scroll swipes (there was no scroll distance left to reach,
 * because the missing term meant the content was already as tall as it
 * would ever get). See `useKeyboardLayoutAnimation.test.ts`.
 *
 * 1357 — Guus's layout ruling moved the filter capsules out of this element
 * entirely (they now live at the top of the content area, folded into
 * `headerArea`/`headerHeight` — see FilesScreen.tsx) and turned what was a
 * 3-piece floating stack (capsules + hint + input, offset a fixed `gap`
 * above `GlassTabBar`) into a single flush bar that REPLACES `GlassTabBar`
 * in its own footprint (`navigation.setOptions({ tabBarStyle: { display:
 * 'none' } })` removes the tab bar from the layout while searching, and this
 * bar sits at `bottom: 0` in the space that reclaims). There is no floating
 * gap between two glass surfaces any more, so the `gap` term is gone —
 * `barHeight` is exactly the bar's own measured height, keyboard clearance
 * included.
 *
 * `keyboardHeight` is clamped to >= 0 defensively — `endCoordinates.height`
 * is not expected to ever be negative, but a negative padding would be a
 * worse failure mode (clipping content) than merely under-padding.
 */
export function computeSearchStackBottomPadding({
  barHeight,
  fallbackHeight,
  keyboardHeight,
}: {
  barHeight: number;
  fallbackHeight: number;
  keyboardHeight: number;
}): number {
  return (barHeight || fallbackHeight) + Math.max(0, keyboardHeight);
}

export function useKeyboardLayoutAnimation() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;

    const show = Keyboard.addListener('keyboardWillShow', (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardHeight(event.endCoordinates.height);
    });
    // Reset to 0 on hide — a screen that stays open with the keyboard
    // dismissed (search bar cancel button, "Done" on the input, etc.) must
    // not keep charging its floating elements for a keyboard that is gone.
    const hide = Keyboard.addListener('keyboardWillHide', (event: KeyboardEvent) => {
      Keyboard.scheduleLayoutAnimation(event);
      setKeyboardHeight(0);
    });

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return { keyboardHeight };
}
