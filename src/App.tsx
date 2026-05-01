import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, type AppStateStatus, StyleSheet, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from './theme';
import { ThemeProvider, useTheme } from './lib/theme-context';
import { BBLogo } from './components/BBLogo';
import {
  hasToken,
  clearToken,
  getMe,
  logout,
  registerSessionExpiredHandler,
} from './lib/api';
import type { User } from './lib/api';
import { AuthContext } from './lib/auth';
import { CryptoProvider, useCrypto } from './lib/crypto-context';
import { useNetworkStatus } from './lib/useNetworkStatus';
import * as Haptics from 'expo-haptics';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';

// Eager screens — auth entry points and tab destinations (Tab navigator handles its own lazy mounting)
import LoginScreen from './screens/LoginScreen';
import SignupScreen from './screens/SignupScreen';
import FilesScreen from './screens/FilesScreen';
import SharedScreen from './screens/SharedScreen';
import PhotosScreen from './screens/PhotosScreen';
import SettingsScreen from './screens/SettingsScreen';

// Lazy stack/overlay screens — module evaluation is deferred until first navigation
const PreviewScreen = React.lazy(() => import('./screens/PreviewScreen'));
const ShareSheetScreen = React.lazy(() => import('./screens/ShareSheetScreen'));
const SharedViewScreen = React.lazy(() => import('./screens/SharedViewScreen'));
const TrashScreen = React.lazy(() => import('./screens/TrashScreen'));
const BackupGuidesScreen = React.lazy(() => import('./screens/BackupGuidesScreen'));
const RecoveryPhraseScreen = React.lazy(() => import('./screens/RecoveryPhraseScreen'));
const RecoveryPhraseVerifyScreen = React.lazy(() => import('./screens/RecoveryPhraseVerifyScreen'));
const DevicePairingScreen = React.lazy(() => import('./screens/DevicePairingScreen'));
const DevicePairingScanScreen = React.lazy(() => import('./screens/DevicePairingScanScreen'));
const DevicePairingShowScreen = React.lazy(() => import('./screens/DevicePairingShowScreen'));
const PairingConfirmScreen = React.lazy(() => import('./screens/PairingConfirmScreen'));
const BiometricLockScreen = React.lazy(() => import('./screens/BiometricLockScreen'));
const OnboardingScreen = React.lazy(() => import('./screens/OnboardingScreen'));

import ErrorBoundary from './components/ErrorBoundary';
import { BackupProvider } from './lib/backup-context';

const ONBOARDING_KEY = 'beebeeb_onboarding_done';

// ---------------------------------------------------------------------------
// Navigation types
// ---------------------------------------------------------------------------

export type TabParamList = {
  Files: undefined;
  Shared: undefined;
  Photos: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  // Auth screens
  Login: undefined;
  Signup: undefined;
  // Main app
  Tabs: undefined;
  Trash: undefined;
  Preview: {
    fileId: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    createdAt?: string;
  };
  ShareSheet: {
    fileId: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
  };
  // Incoming share link: beebeeb://s/:token or https://beebeeb.io/s/:token
  SharedView: { token: string };
  BackupGuides: undefined;
  // Auth / onboarding upgrade screens
  RecoveryPhrase: { phrase?: string[] };
  RecoveryPhraseVerify: { phrase: string[] };
  // Device pairing (Amber Constellation)
  DevicePairing: undefined;
  DevicePairingScan: undefined;
  DevicePairingShow: undefined;
  PairingConfirm: { progress: number; nodeCount: number };
};

// ---------------------------------------------------------------------------
// Deep linking configuration
// ---------------------------------------------------------------------------

const linking = {
  prefixes: ['beebeeb://', 'https://beebeeb.io', 'http://beebeeb.io'],
  config: {
    screens: {
      Tabs: '',
      SharedView: 's/:token',
    },
  },
};

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

// ---------------------------------------------------------------------------
// Offline banner
// ---------------------------------------------------------------------------

function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  return (
    <View style={[offlineStyles.banner, { top: insets.top + 8 }]}>
      <View style={offlineStyles.iconCircle}>
        <View style={offlineStyles.iconDot} />
      </View>
      <View style={offlineStyles.textBlock}>
        <Text style={[offlineStyles.title, { color: c.ink }]}>No connection</Text>
        <Text style={[offlineStyles.sub, { color: c.ink3 }]}>Working from your device · changes will sync when you're back</Text>
      </View>
    </View>
  );
}

const offlineStyles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#faf5e4',
    borderWidth: 1,
    borderColor: '#e2d5b0',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 4,
  },
  iconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#e8d9a0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#8a6d20',
  },
  textBlock: { flex: 1 },
  title: { fontSize: 12, fontWeight: '600', color: colors.ink },
  sub: { fontSize: 10.5, color: colors.ink3, marginTop: 1 },
});

// ---------------------------------------------------------------------------
// Tab icon using Ionicons (SF Symbols on iOS)
// ---------------------------------------------------------------------------

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const TAB_ICON_NAMES: Record<string, [IoniconName, IoniconName]> = {
  Files: ['folder', 'folder-outline'],
  Shared: ['people', 'people-outline'],
  Photos: ['images', 'images-outline'],
  Settings: ['settings', 'settings-outline'],
};

function TabIcon({ name, focused, color }: { name: string; focused: boolean; color: string }) {
  const icons = TAB_ICON_NAMES[name];
  const iconName: IoniconName = icons ? (focused ? icons[0] : icons[1]) : 'ellipse-outline';
  return <Ionicons name={iconName} size={22} color={color} />;
}

// ---------------------------------------------------------------------------
// Suspense fallback for lazy-loaded screens
// ---------------------------------------------------------------------------

function ScreenLoadingFallback() {
  const { colors: c } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.paper }}>
      <ActivityIndicator color={c.ink3} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Biometric guard — lives inside CryptoProvider so it can call useCrypto()
// ---------------------------------------------------------------------------

function BiometricGuard({ locked, onUnlock }: { locked: boolean; onUnlock: () => void }) {
  const crypto = useCrypto();

  async function handleUnlocked() {
    try {
      await crypto.unlock();
    } catch {
      // Key not in keychain yet (e.g. legacy account before OPAQUE) — just unlock the screen
    }
    onUnlock();
  }

  if (!locked) return null;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      <BiometricLockScreen onUnlocked={handleUnlocked} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tab Navigator
// ---------------------------------------------------------------------------

function TabNavigator() {
  const { colors: c } = useTheme();
  return (
    <Tab.Navigator
      screenListeners={{
        tabPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color }) => <TabIcon name={route.name} focused={focused} color={color} />,
        tabBarActiveTintColor: c.ink,
        tabBarInactiveTintColor: c.ink4,
        tabBarStyle: {
          backgroundColor: c.paper,
          borderTopColor: c.line,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          fontSize: 9.5,
          fontWeight: '500' as const,
        },
      })}
    >
      <Tab.Screen name="Files" component={FilesScreen} />
      <Tab.Screen name="Shared" component={SharedScreen} />
      <Tab.Screen name="Photos" component={PhotosScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------

export default function App() {
  const { colors: c, resolved } = useTheme();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  // Biometric lock: show lock screen when app resumes from background
  const [locked, setLocked] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Onboarding: shown once after first signup
  const [onboardingDone, setOnboardingDone] = useState(true); // true by default, corrected in startup

  const isConnected = useNetworkStatus();

  const refreshAuth = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
    } catch {
      // Token invalid or expired — stay on login
      await clearToken();
      setUser(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      await clearToken();
    }
    setUser(null);
  }, []);

  // On mount: check for an existing session
  useEffect(() => {
    (async () => {
      const tokenExists = await hasToken();
      if (tokenExists) {
        // Validate the token by calling /auth/me
        try {
          const me = await getMe();
          setUser(me);
        } catch {
          await clearToken();
        }
      }
      // Check onboarding state — only show for new signups, not existing logins
      try {
        const done = await SecureStore.getItemAsync(ONBOARDING_KEY);
        // If key doesn't exist but user already has a token, they're an existing user — skip onboarding
        setOnboardingDone(done === 'true' || tokenExists);
      } catch {
        setOnboardingDone(true); // assume done if SecureStore unavailable (web)
      }

      setChecking(false);
    })();
  }, []);

  // Register session-expired handler so 401s auto-sign-out
  useEffect(() => {
    registerSessionExpiredHandler(() => {
      setUser(null);
    });
  }, []);

  // Lock the app when it goes to background and biometric pref is on
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      if (
        (prev === 'background' || prev === 'inactive') &&
        nextState === 'active'
      ) {
        try {
          const pref = await SecureStore.getItemAsync(BIOMETRIC_PREF_KEY);
          if (pref === 'true') {
            setLocked(true);
          }
        } catch {
          // SecureStore unavailable (e.g. web) — ignore
        }
      }
    });
    return () => subscription.remove();
  }, []);

  // Listen for successful login/signup from auth screens
  // by polling the token after navigation events
  const handleNavigationStateChange = useCallback(async () => {
    if (!user) {
      const tokenExists = await hasToken();
      if (tokenExists) {
        await refreshAuth();
      }
    }
  }, [user, refreshAuth]);

  // Loading splash while checking auth
  if (checking) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center' }}>
          <BBLogo size={48} />
          <View style={{ height: 16 }} />
          <ActivityIndicator color={c.ink3} />
        </View>
        <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      </SafeAreaProvider>
    );
  }

  const isAuthenticated = user !== null;

  return (
    <AuthContext.Provider value={{ user, refreshAuth, signOut }}>
      <CryptoProvider>
      <BackupProvider>
      <SafeAreaProvider>
        <Suspense fallback={<ScreenLoadingFallback />}>
          <NavigationContainer linking={linking} onStateChange={handleNavigationStateChange}>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              {isAuthenticated ? (
                <>
                  <Stack.Screen name="Tabs" component={TabNavigator} />
                  <Stack.Screen
                    name="Preview"
                    component={PreviewScreen}
                    options={{ presentation: 'fullScreenModal', animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen
                    name="ShareSheet"
                    component={ShareSheetScreen}
                    options={{
                      presentation: 'transparentModal',
                      animation: 'slide_from_bottom',
                      contentStyle: { backgroundColor: 'transparent' },
                    }}
                  />
                  <Stack.Screen
                    name="SharedView"
                    component={SharedViewScreen}
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen name="Trash" component={TrashScreen} />
                  <Stack.Screen name="BackupGuides" component={BackupGuidesScreen} />
                  <Stack.Screen name="RecoveryPhrase" component={RecoveryPhraseScreen} />
                  <Stack.Screen name="RecoveryPhraseVerify" component={RecoveryPhraseVerifyScreen} />
                  <Stack.Screen name="DevicePairing" component={DevicePairingScreen} />
                  <Stack.Screen name="DevicePairingScan" component={DevicePairingScanScreen} />
                  <Stack.Screen name="DevicePairingShow" component={DevicePairingShowScreen} />
                  <Stack.Screen name="PairingConfirm" component={PairingConfirmScreen} />
                </>
              ) : (
                <>
                  <Stack.Screen
                    name="Login"
                    component={LoginScreen}
                    options={{ animationTypeForReplace: 'pop' }}
                  />
                  <Stack.Screen name="Signup" component={SignupScreen} />
                </>
              )}
            </Stack.Navigator>
          </NavigationContainer>
        </Suspense>

        {/* Offline banner */}
        {!isConnected && <OfflineBanner />}

        {/* Onboarding overlay — shown once after first signup */}
        {isAuthenticated && !onboardingDone && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.paper2 }}>
            <Suspense fallback={<ScreenLoadingFallback />}>
              <OnboardingScreen
                onComplete={async () => {
                  try {
                    await SecureStore.setItemAsync(ONBOARDING_KEY, 'true');
                  } catch { /* web */ }
                  setOnboardingDone(true);
                }}
              />
            </Suspense>
          </View>
        )}

        {/* Biometric lock overlay — shown when app resumes from background */}
        {isAuthenticated && (
          <Suspense fallback={null}>
            <BiometricGuard locked={locked} onUnlock={() => setLocked(false)} />
          </Suspense>
        )}

        <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      </SafeAreaProvider>
      </BackupProvider>
      </CryptoProvider>
    </AuthContext.Provider>
  );
}

function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

registerRootComponent(AppWithErrorBoundary);
