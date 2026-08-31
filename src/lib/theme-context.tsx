import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { colors, darkColors, type Colors } from '../theme';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  colors: Colors;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  resolved: 'light',
  colors,
  setMode: () => {},
});

const THEME_PREF_KEY = 'beebeeb_theme_pref';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(
    Appearance.getColorScheme() === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    SecureStore.getItemAsync(THEME_PREF_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setModeState(stored);
          if (stored !== 'system' && Appearance.setColorScheme) {
            Appearance.setColorScheme(stored);
          }
        }
      })
      .catch(() => {});

    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme === 'dark' ? 'dark' : 'light');
    });
    return () => sub.remove();
  }, []);

  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode);
    if (Appearance.setColorScheme) {
      Appearance.setColorScheme(newMode === 'system' ? 'unspecified' : newMode);
    }
    SecureStore.setItemAsync(THEME_PREF_KEY, newMode).catch(() => {});
  }, []);

  const resolved: 'light' | 'dark' = mode === 'system' ? systemScheme : mode;
  const themeColors: Colors = resolved === 'dark' ? darkColors : colors;

  const value = useMemo(
    () => ({ mode, resolved, colors: themeColors, setMode }),
    [mode, resolved, themeColors, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
