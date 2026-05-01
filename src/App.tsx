import React, { useCallback, useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, type AppStateStatus, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text } from 'react-native';
import { colors } from './theme';
import {
  hasToken,
  clearToken,
  getMe,
  logout,
  registerSessionExpiredHandler,
} from './lib/api';
import type { User } from './lib/api';
import { AuthContext } from './lib/auth';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';

// Screens
import FilesScreen from './screens/FilesScreen';
import SharedScreen from './screens/SharedScreen';
import PhotosScreen from './screens/PhotosScreen';
import SettingsScreen from './screens/SettingsScreen';
import PreviewScreen from './screens/PreviewScreen';
import ShareSheetScreen from './screens/ShareSheetScreen';
import LoginScreen from './screens/LoginScreen';
import SignupScreen from './screens/SignupScreen';
import BiometricLockScreen from './screens/BiometricLockScreen';

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
};

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

// ---------------------------------------------------------------------------
// Simple text-based tab icon (avoids icon library dep for now)
// ---------------------------------------------------------------------------

const TAB_ICONS: Record<string, string> = {
  Files: '\u{1F4C1}',
  Shared: '\u{1F465}',
  Photos: '\u{1F5BC}️',
  Settings: '⚙️',
};

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  return (
    <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.5 }}>
      {TAB_ICONS[name] ?? '?'}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Tab Navigator
// ---------------------------------------------------------------------------

function TabNavigator() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused }) => <TabIcon name={route.name} focused={focused} />,
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.ink4,
        tabBarStyle: {
          backgroundColor: colors.paper,
          borderTopColor: colors.line,
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
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  // Biometric lock: show lock screen when app resumes from background
  const [locked, setLocked] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

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
        <View style={{ flex: 1, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{
            width: 48, height: 48, borderRadius: 12,
            backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center',
            marginBottom: 16,
          }}>
            <Text style={{ color: colors.amber, fontSize: 18, fontWeight: '800', letterSpacing: -0.5 }}>
              bb
            </Text>
          </View>
          <ActivityIndicator color={colors.ink3} />
        </View>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    );
  }

  const isAuthenticated = user !== null;

  return (
    <AuthContext.Provider value={{ user, refreshAuth, signOut }}>
      <SafeAreaProvider>
        <NavigationContainer onStateChange={handleNavigationStateChange}>
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

        {/* Biometric lock overlay — shown when app resumes from background */}
        {isAuthenticated && locked && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <BiometricLockScreen onUnlocked={() => setLocked(false)} />
          </View>
        )}

        <StatusBar style="auto" />
      </SafeAreaProvider>
    </AuthContext.Provider>
  );
}

registerRootComponent(App);
