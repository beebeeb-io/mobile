/**
 * React Navigation themes built from the app's own tokens (task 1320).
 *
 * The app never passed a `theme` to `NavigationContainer`, so react-navigation
 * fell back to its light `DefaultTheme` and painted container backgrounds
 * WHITE regardless of the app's colour scheme. That was invisible while every
 * surface was opaque — each screen's own root View covered the container. Task
 * 1312's floating tab bar was the first transparent chrome in the app and it
 * exposed the white band underneath, which was patched locally on the tab bar.
 *
 * Every remaining phase of the iOS 26 redesign makes more surfaces
 * transparent, so the fix belongs here once rather than at each call site.
 *
 * Scope note: `Stack.Navigator` sets `headerShown: false` globally and the tab
 * bar is a custom component, so `card`, `text`, `border` and `primary` never
 * paint anything today. They are still set correctly — a future screen that
 * turns a header on should inherit the right colours rather than react-
 * navigation's blue-on-white defaults.
 */

import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

import { colors, darkColors } from '../theme';

export const navigationLightTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    // The container behind every screen. This is the one that was white.
    background: colors.paper,
    card: colors.paper,
    text: colors.ink,
    border: colors.line,
    primary: colors.amberDeep,
    notification: colors.red,
  },
};

export const navigationDarkTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: darkColors.paper,
    card: darkColors.paper,
    text: darkColors.ink,
    border: darkColors.line,
    primary: darkColors.amber,
    notification: darkColors.red,
  },
};

export function navigationThemeFor(scheme: 'light' | 'dark'): Theme {
  return scheme === 'dark' ? navigationDarkTheme : navigationLightTheme;
}
