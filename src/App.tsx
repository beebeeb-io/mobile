import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, type AppStateStatus, Keyboard, Linking, Platform, StyleSheet, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Icon } from './components/Icon';
import { colors } from './theme';
import * as Font from 'expo-font';
import { ThemeProvider, useTheme } from './lib/theme-context';
import { ToastProvider } from './lib/toast-context';
import { BBLogo } from './components/BBLogo';
import {
  hasToken,
  clearToken,
  getApiUrl,
  getMe,
  getToken,
  logout,
  getStorageUsage,
  registerSessionExpiredHandler,
} from './lib/api';
import type { User } from './lib/api';
import { AuthContext } from './lib/auth';
import { CryptoProvider, SIMULATOR_MASTER_KEY_FILE, useCrypto } from './lib/crypto-context';
import { markUnlocked, wasRecentlyUnlocked } from './lib/lock-state';
import { SyncProvider } from './lib/sync-context';
import { useNetworkStatus } from './lib/useNetworkStatus';
import { setPendingShareKey } from './lib/share-key-store';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as BeebeebCrypto from '../modules/beebeeb-crypto';
import { populateFileProviderCache } from './lib/file-provider-mount';
import {
  setupNotificationHandler,
  registerForPushNotifications,
  unregisterPushToken,
  handleNotificationTap,
} from './lib/push-notifications';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';
const BIOMETRIC_DELAY_KEY = 'beebeeb_biometric_delay';

const optionalFontAssets: Record<string, number> = {};

try {
  optionalFontAssets['JetBrainsMono-Regular'] = require('../assets/fonts/JetBrainsMono-Regular.ttf') as number;
} catch {
  // Optional brand font is not committed in all builds; React Native falls back to the platform monospace.
}

try {
  optionalFontAssets['JetBrainsMono-Medium'] = require('../assets/fonts/JetBrainsMono-Medium.ttf') as number;
} catch {
  // Optional brand font is not committed in all builds; React Native falls back to the platform monospace.
}

// Eager screens — auth entry points and tab destinations (Tab navigator handles its own lazy mounting)
import LoginScreen from './screens/LoginScreen';
import SignupScreen from './screens/SignupScreen';
import FilesScreen from './screens/FilesScreen';
import SharedScreen from './screens/SharedScreen';
import PhotosScreen from './screens/PhotosScreen';
import SettingsScreen from './screens/SettingsScreen';

import PreviewScreen from './screens/PreviewScreen';
import ShareSheetScreen from './screens/ShareSheetScreen';
import SharedViewScreen from './screens/SharedViewScreen';
import TrashScreen from './screens/TrashScreen';
import BackupGuidesScreen from './screens/BackupGuidesScreen';
import PrivacyScreen from './screens/PrivacyScreen';
import StorageScreen from './screens/StorageScreen';
import RecoveryPhraseVerifyScreen from './screens/RecoveryPhraseVerifyScreen';
import RecoveryUnlockScreen from './screens/RecoveryUnlockScreen';
import DevicePairingScreen from './screens/DevicePairingScreen';
import DevicePairingScanScreen from './screens/DevicePairingScanScreen';
import DevicePairingShowScreen from './screens/DevicePairingShowScreen';
import PairingConfirmScreen from './screens/PairingConfirmScreen';
import ConstellationSendScreen from './screens/ConstellationSendScreen';
import BiometricLockScreen from './screens/BiometricLockScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import DocumentScannerScreen from './screens/DocumentScannerScreen';
import TwoFactorSetupScreen from './screens/TwoFactorSetupScreen';
import BackupInsightsScreen from './screens/BackupInsightsScreen';
import SpeedtestScreen from './screens/SpeedtestScreen';
import AdvancedSettingsScreen from './screens/AdvancedSettingsScreen';

import ErrorBoundary from './components/ErrorBoundary';
import ConfirmActionPrompt from './components/ConfirmActionPrompt';
import { DiagnosticPanel, LAST_CONNECTED_KEY } from './components/DiagnosticPanel';
import { BackupProvider, useBackup } from './lib/backup-context';
import { discardAllPendingShares, processPendingShares } from '../plugins/share-extension/PendingSharesHandler';
import { useToast } from './lib/toast-context';
import { clearWidgetData } from './utils/widgetData';
import { ensureDevicePerformanceProfile } from './lib/device-performance';
import { ThumbnailRepairWorker } from './lib/ThumbnailRepairWorker';

const ONBOARDING_KEY = 'beebeeb_onboarding_done';
const PHRASE_VERIFIED_KEY = 'beebeeb_phrase_verified';
const MASTER_KEY_CHECK_LABEL = 'io.beebeeb.master-key-check';
const MASTER_KEY_FALLBACK_LABEL = 'io.beebeeb.master-key.fallback';
const STARTUP_STEP_TIMEOUT_MS = 5000;

function withStartupTimeout<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => {
        console.warn(`[Beebeeb] Startup step timed out: ${label}`);
        resolve(fallback);
      }, STARTUP_STEP_TIMEOUT_MS);
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Navigation types
// ---------------------------------------------------------------------------

export type TabParamList = {
  // `action` lets deep links / quick actions ask Files to do something on
  // arrival (`'upload'` opens the picker, `'search'` focuses the search bar,
  // `'scan'` opens document scanner, `'recent'` shows last-24h filter).
  // FilesScreen consumes & clears the param so the action only fires once.
  Files: { action?: 'upload' | 'search' | 'scan' | 'recent' } | undefined;
  Shared: undefined;
  Photos: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  // Auth screens
  Login: { returnTo?: 'DevicePairingScan' } | undefined;
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
    versionNumber?: number;
    storagePoolId?: string | null;
    /** Number of encrypted chunks. Multi-chunk files (>1) can't be previewed yet. */
    chunkCount?: number;
    /** Serialised JSON array of photo entries for swipe navigation from PhotosScreen. */
    photoListJson?: string;
    /** Index of the tapped photo within the photoList. */
    initialPhotoIndex?: number;
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
  RecoveryUnlock: undefined;
  Privacy: undefined;
  Storage: undefined;
  // Device pairing (Amber Constellation)
  DevicePairing: undefined;
  DevicePairingScan: undefined;
  DevicePairingShow: undefined;
  PairingConfirm: { progress: number; nodeCount: number };
  // Constellation peer transfer — sender flow.
  ConstellationSend: { fileId: string; fileName: string };
  DocumentScanner: { parentId?: string } | undefined;
  TwoFactorSetup: undefined;
  BackupInsights: undefined;
  Speedtest: undefined;
  AdvancedSettings: undefined;
};

// ---------------------------------------------------------------------------
// Deep linking configuration
// ---------------------------------------------------------------------------

const linking = {
  prefixes: ['beebeeb://', 'https://beebeeb.io'],
  config: {
    screens: {
      Tabs: {
        // Bare tab name → its tab. beebeeb://photos lands on Photos,
        // beebeeb://shared on Shared, etc. Files keeps the empty path so
        // a plain beebeeb:// (or app cold-launch) opens the default tab.
        // beebeeb://upload and beebeeb://search are intercepted in
        // handleShortcutURL below so they can pass an `action` param.
        screens: {
          Files: 'files',
          Shared: 'shared',
          Photos: 'photos',
          Settings: 'settings',
        },
        path: '',
      },
      SharedView: 's/:token',
      BackupInsights: 'settings/backup-insights',
    },
  },
};

const Tab = createBottomTabNavigator<TabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

// Module-level nav ref so non-component code (deep-link handler / quick
// action listener) can dispatch navigation without a hook.
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function isBackupInsightsURL(url: string): boolean {
  const normalized = url.toLowerCase().replace(/\/+$/, '');
  return normalized === 'beebeeb://settings/backup-insights' ||
    normalized === 'https://beebeeb.io/settings/backup-insights';
}

function dispatchWhenNavigationReady(dispatch: () => void, attempt = 0): void {
  if (navigationRef.isReady()) {
    dispatch();
    return;
  }
  if (attempt >= 30) return;
  setTimeout(() => dispatchWhenNavigationReady(dispatch, attempt + 1), 150);
}

// Configure in-foreground notification display before any component mounts.
setupNotificationHandler();

// ---------------------------------------------------------------------------
// Offline banner
// ---------------------------------------------------------------------------

function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  return (
    <View style={[offlineStyles.banner, { top: insets.top + 8, backgroundColor: c.amberBg, borderColor: c.line }]}>
      <View style={[offlineStyles.iconCircle, { backgroundColor: c.line2 }]}>
        <Ionicons name="cloud-offline-outline" size={14} color={c.amberDeep} />
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
    borderWidth: 1,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  textBlock: { flex: 1 },
  title: { fontSize: 12, fontWeight: '600' },
  sub: { fontSize: 10.5, marginTop: 1 },
});

// ---------------------------------------------------------------------------
// Tab icon — Beebeeb Icon component (Feather stroke style, matches web)
// ---------------------------------------------------------------------------

import type { IconName } from './components/Icon';

const TAB_ICON_MAP: Record<string, IconName> = {
  Files:    'folder',
  Shared:   'share',
  Photos:   'image',
  Settings: 'settings',
};

function TabIcon({ name, focused, color }: { name: string; focused: boolean; color: string }) {
  const iconName = TAB_ICON_MAP[name] ?? 'file';
  // Feather doesn't have filled variants; increase strokeWidth on focus for visual weight
  return (
    <Icon
      name={iconName}
      size={22}
      color={color}
      style={{ opacity: focused ? 1 : 0.7 }}
    />
  );
}

// ---------------------------------------------------------------------------
// Share Extension dropbox drain — runs inside ToastProvider so we can toast
// imported counts, and depends on `user` so we never upload while signed out.
// ---------------------------------------------------------------------------

function ShareSheetImporter({ enabled }: { enabled: boolean }) {
  const { showToast } = useToast();
  const { isUnlocked, encryptChunk, encryptMetadata } = useCrypto();
  const enabledRef = useRef(enabled);
  const cryptoRef = useRef({ isUnlocked, encryptChunk, encryptMetadata });
  enabledRef.current = enabled;
  cryptoRef.current = { isUnlocked, encryptChunk, encryptMetadata };

  const drain = useCallback(async () => {
    if (!enabledRef.current) return;
    try {
      const crypto = cryptoRef.current;
      const result = await processPendingShares({
        vaultUnlocked: crypto.isUnlocked,
        encryptChunkFn: crypto.encryptChunk,
        encryptMetadataFn: crypto.encryptMetadata,
      });
      if (result.uploaded > 0) {
        const noun = result.uploaded === 1 ? 'file' : 'files';
        showToast({ type: 'success', message: `${result.uploaded} ${noun} imported from share sheet` });
      }
      if (result.failed > 0) {
        showToast({ type: 'error', message: `${result.failed} share import${result.failed === 1 ? '' : 's'} failed` });
      }
      if (result.skipped > 0 && !crypto.isUnlocked) {
        const noun = result.skipped === 1 ? 'file' : 'files';
        showToast({ type: 'info', message: `Unlock Beebeeb to import ${result.skipped} shared ${noun}` });
      }
    } catch {
      // never let the importer crash the app
    }
  }, [showToast]);

  // Drain on first render once enabled, then again on every foreground.
  useEffect(() => {
    if (enabled) drain();
  }, [enabled, drain]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') drain();
    });
    return () => sub.remove();
  }, [drain]);

  return null;
}

// ---------------------------------------------------------------------------
// Biometric guard — lives inside CryptoProvider so it can call useCrypto()
// ---------------------------------------------------------------------------

function BiometricGuard({ locked, onUnlock }: { locked: boolean; onUnlock: () => void }) {
  const crypto = useCrypto();

  // Silent vault unlock — runs exactly ONCE on cold launch.
  // After that, all unlocks come from BiometricLockScreen.handleUnlocked().
  // The ref prevents re-triggering on every foreground/tab switch.
  const silentUnlockDone = useRef(false);
  useEffect(() => {
    if (silentUnlockDone.current) return;
    if (locked) return;
    if (crypto.isUnlocked) { silentUnlockDone.current = true; return; }
    silentUnlockDone.current = true;
    crypto.unlock(undefined, 'cold_launch_vault_unlock').catch(() => {});
  }, [locked, crypto.isUnlocked]);

  async function handleUnlocked() {
    try {
      await crypto.unlock(undefined, 'app_biometric_lock_screen');
    } catch {
      // Key not in keychain yet (e.g. legacy account before OPAQUE) — just unlock the screen
    }
    const token = await getToken().catch(() => null);
    if (token) {
      await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl()).catch(() => false);
    }
    // Pre-populate FileProvider cache with decrypted names so iOS Files
    // shows real names immediately without needing to open the Files tab first.
    populateFileProviderCache(crypto.decryptMetadata).catch(() => {});
    onUnlock();
  }

  if (!locked) return null;
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
      <BiometricLockScreen onUnlocked={handleUnlocked} />
    </View>
  );
}

function VaultRecoveryGate({ enabled, navReady }: { enabled: boolean; navReady: boolean }) {
  const crypto = useCrypto();

  useEffect(() => {
    if (!enabled || !crypto.unlockAttempted || crypto.isUnlocked) return;
    // Bail until the navigation container is ready. navReady is in the dep
    // array so this effect re-fires the moment nav becomes ready, even if
    // crypto.unlockAttempted flipped to true earlier (common on cold launch
    // when keychain auto-unlock fails fast before NavigationContainer's
    // onReady fires).
    if (!navReady || !navigationRef.isReady()) return;

    const currentRoute = navigationRef.getCurrentRoute()?.name;
    if (
      currentRoute === 'RecoveryUnlock' ||
      currentRoute === 'RecoveryPhrase' ||
      currentRoute === 'RecoveryPhraseVerify'
    ) {
      return;
    }

    navigationRef.navigate('RecoveryUnlock');
  }, [enabled, navReady, crypto.unlockAttempted, crypto.isUnlocked]);

  return null;
}

function FileProviderDomainRegistrar({ enabled }: { enabled: boolean }) {
  const crypto = useCrypto();
  const registeringRef = useRef(false);
  const attemptedRef = useRef(false);

  const register = useCallback(async () => {
    if (Platform.OS !== 'ios' || !enabled || !crypto.isUnlocked) return;
    if (registeringRef.current || attemptedRef.current) return;

    registeringRef.current = true;
    attemptedRef.current = true;
    try {
      const token = await getToken();
      if (!token) return;
      await BeebeebCrypto.mirrorSessionToAppGroup(token, getApiUrl()).catch(() => false);
      const result = await BeebeebCrypto.registerFileProviderDomain();
      const mounted = result.registered && result.cacheDatabaseReady !== false;
      if (mounted) {
        void populateFileProviderCache(crypto.decryptMetadata).catch(() => {});
      }
      if (__DEV__) {
        console.log('[FileProvider] domain registration', result);
      }
    } catch (error) {
      if (__DEV__) {
        console.warn('[FileProvider] domain registration failed', error);
      }
    } finally {
      registeringRef.current = false;
    }
  }, [crypto.decryptMetadata, crypto.isUnlocked, enabled]);

  useEffect(() => {
    attemptedRef.current = false;
  }, [crypto.isUnlocked, enabled]);

  useEffect(() => {
    void register();
  }, [register]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void register();
      }
    });
    return () => sub.remove();
  }, [register]);

  return null;
}

// ---------------------------------------------------------------------------
// Tab Navigator
// ---------------------------------------------------------------------------

function TabNavigator() {
  const { colors: c } = useTheme();
  const backup = useBackup();
  // Check storage on mount — show badge on Settings tab when >= 80% full
  const [storageWarning, setStorageWarning] = useState(false);
  useEffect(() => {
    getStorageUsage()
      .then(u => { if (u.plan_limit_bytes > 0) setStorageWarning(u.used_bytes / u.plan_limit_bytes >= 0.8); })
      .catch(() => {});
  }, []);

  // Backup badge is driven by the native backup engine state.
  const backupRunning =
    ['preparing', 'encrypting', 'uploading'].includes(backup.backupProgress.state) ||
    backup.backupProgress.inProgress > 0;
  const backupFailed = backup.backupProgress.failed > 0;
  const settingsBadge = backupFailed
    ? { tabBarBadge: ' ', tabBarBadgeStyle: { backgroundColor: c.red, minWidth: 10, maxHeight: 10, borderRadius: 5, fontSize: 1 } }
    : backupRunning
      ? { tabBarBadge: ' ', tabBarBadgeStyle: { backgroundColor: c.amber, minWidth: 10, maxHeight: 10, borderRadius: 5, fontSize: 1 } }
      : storageWarning
        ? { tabBarBadge: '!', tabBarBadgeStyle: { backgroundColor: c.amberDeep, fontSize: 9 } }
        : {};

  return (
    <Tab.Navigator
      screenListeners={{
        tabPress: () => {
          Keyboard.dismiss();
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
      }}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color }) => <TabIcon name={route.name} focused={focused} color={color} />,
        tabBarActiveTintColor: c.amber,
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
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={settingsBadge}
      />
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
  const [loadingStatus, setLoadingStatus] = useState('');
  const [loadingFailed, setLoadingFailed] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const [fontsLoaded] = Font.useFonts(optionalFontAssets);
  // fontsLoaded is false until fonts resolve — app renders fine either way
  // (RN silently falls back to system monospace for unknown family names)
  void fontsLoaded; // used implicitly: font is available once loaded

  // Biometric lock: show lock screen when app resumes from background
  const [locked, setLocked] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const backgroundAtRef = useRef<number | null>(null);

  // Onboarding: shown once after first signup
  const [onboardingDone, setOnboardingDone] = useState(true); // true by default, corrected in startup
  // Phrase verification: false until the user types back their recovery words.
  // Defaults to true so existing (pre-phrase-flow) users are unaffected.
  const [phraseVerified, setPhraseVerified] = useState(true);
  const [pendingRecoveryPhrase, setPendingRecoveryPhrase] = useState<string[] | null>(null);
  const [navReady, setNavReady] = useState(false);

  const isConnected = useNetworkStatus();

  const refreshAuth = useCallback(async () => {
    try {
      const me = await getMe();
      setUser(me);
      SecureStore.setItemAsync(LAST_CONNECTED_KEY, new Date().toISOString()).catch(() => {});
      // Register push token once the user is authenticated.
      void registerForPushNotifications();
    } catch {
      // Token invalid or expired — stay on login
      await clearToken();
      setUser(null);
    }
  }, []);

  // Handle notification taps — deep-link to the relevant screen.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationTap(response, navigationRef);
    });
    return () => sub.remove();
  }, []);

  const signOut = useCallback(async () => {
    // Remove the push token before clearing the session.
    void unregisterPushToken();
    try {
      await logout();
    } catch {
      await clearToken();
    }
    await BeebeebCrypto.deleteKeyFromKeychain().catch(() => false);
    await BeebeebCrypto.removeFileProviderAccess().catch(() => null);
    await BeebeebCrypto.mirrorSessionToAppGroup(null, null).catch(() => false);
    await BeebeebCrypto.mirrorSimulatorFileProviderMasterKey(null).catch(() => false);
    await discardAllPendingShares().catch(() => 0);
    await clearWidgetData().catch(() => {});
    await SecureStore.deleteItemAsync(MASTER_KEY_CHECK_LABEL).catch(() => {});
    await SecureStore.deleteItemAsync(MASTER_KEY_FALLBACK_LABEL).catch(() => {});
    await FileSystem.deleteAsync(SIMULATOR_MASTER_KEY_FILE, { idempotent: true }).catch(() => {});
    setUser(null);
  }, []);

  // Retry getMe() up to 3 times with backoff before giving up
  const retryGetMe = useCallback(async (): Promise<User | null> => {
    const delays = [1000, 3000, 5000];
    for (const delay of delays) {
      try {
        return await Promise.race([
          getMe(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 10_000),
          ),
        ]);
      } catch {
        await new Promise(r => setTimeout(r, delay));
      }
    }
    return null; // all retries failed
  }, []);

  // Shared preferences loader — called from runStartup and also when
  // diagnostics are on screen so prefs are ready when the user retries.
  const loadPreferences = useCallback(async (tokenExists: boolean) => {
    // Check onboarding state. A fresh install with no token should not show
    // onboarding immediately after an existing user signs in; signup owns its
    // recovery phrase flow explicitly.
    try {
      const done = await SecureStore.getItemAsync(ONBOARDING_KEY);
      setOnboardingDone(done !== 'false' || tokenExists);
    } catch {
      setOnboardingDone(true); // assume done if SecureStore unavailable (web)
    }

    // Check phrase verification state — only applies to new OPAQUE signups.
    // Existing users who pre-date the phrase flow are treated as verified.
    try {
      const phraseKey = await SecureStore.getItemAsync(PHRASE_VERIFIED_KEY);
      // 'pending' means signup set the flag but verification wasn't completed.
      // Absent key (legacy user) or 'verified' both mean verified = true.
      setPhraseVerified(phraseKey !== 'pending');
    } catch {
      setPhraseVerified(true);
    }
  }, []);

  // Full startup flow — extracted so the diagnostic panel's Retry can rerun it
  const runStartup = useCallback(async () => {
    setShowDiagnostics(false);
    setLoadingFailed(false);
    setLoadingStatus('');
    setChecking(true);

    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    let needsDiagnostics = false;

    try {
      const tokenExists = await withStartupTimeout(hasToken(), false, 'read session token');
      if (tokenExists) {
        setLoadingStatus('Contacting server...');
        slowTimer = setTimeout(() => setLoadingStatus('Taking longer than usual...'), 5_000);

        const me = await retryGetMe();
        clearTimeout(slowTimer);
        slowTimer = undefined;

        if (me) {
          setLoadingStatus('Unlocking vault...');
          setUser(me);
          SecureStore.setItemAsync(LAST_CONNECTED_KEY, new Date().toISOString()).catch(() => {});
        } else {
          // All retries exhausted — show diagnostics
          needsDiagnostics = true;
          setLoadingStatus('');
          setShowDiagnostics(true);
        }
      }

      // When diagnostics are showing, keep the splash screen visible — don't
      // fall through to the auth/main navigator until the user retries or
      // chooses to sign in.
      if (needsDiagnostics) {
        // Still load preferences in the background so they're ready on retry
        void withStartupTimeout(loadPreferences(tokenExists), undefined, 'load preferences');
        return;
      }

      setLoadingStatus('Loading preferences...');
      await withStartupTimeout(loadPreferences(tokenExists), undefined, 'load preferences');

      setChecking(false);
    } catch (err) {
      console.warn('[Beebeeb] Startup failed; falling back to signed-out state', err);
      setUser(null);
      setLoadingStatus('');
      setShowDiagnostics(false);
      setChecking(false);
    } finally {
      if (slowTimer) clearTimeout(slowTimer);
    }
  }, [retryGetMe, loadPreferences]);

  // On mount: check for an existing session
  useEffect(() => {
    void runStartup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register session-expired handler so 401s auto-sign-out
  useEffect(() => {
    registerSessionExpiredHandler(() => {
      setUser(null);
    });
  }, []);

  // Lock the app when it goes to background and biometric pref is on.
  // The user-configurable delay (BIOMETRIC_DELAY_KEY, in ms) lets a quick
  // app-switcher peek skip the lock — only background longer than `delay`
  // triggers Face ID on resume.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextState: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      // Only `background` resets the timer. `inactive` is fired by the system
      // for incidental events (notification panel pull, biometric prompts,
      // share sheet, app switcher peek) and must not be treated as the user
      // leaving the app. Without this distinction the Face ID prompt itself
      // produces an inactive→active cycle that re-locks immediately.
      if (nextState === 'background') {
        if (backgroundAtRef.current == null) {
          backgroundAtRef.current = Date.now();
        }
        return;
      }

      if (prev === 'background' && nextState === 'active') {
        const elapsed = backgroundAtRef.current != null ? Date.now() - backgroundAtRef.current : 0;
        backgroundAtRef.current = null;

        // Recently authenticated? The system briefly backgrounds the app
        // around the Face ID prompt and again right after enabling the
        // setting. Skip the lock so we don't bounce the user.
        if (wasRecentlyUnlocked()) return;

        try {
          const pref = await SecureStore.getItemAsync(BIOMETRIC_PREF_KEY);
          if (pref !== 'true') return;
          const delayRaw = await SecureStore.getItemAsync(BIOMETRIC_DELAY_KEY);
          const delay = delayRaw ? parseInt(delayRaw, 10) : 0;
          if (elapsed > delay) {
            setLocked(true);
          }
        } catch {
          // SecureStore unavailable (e.g. web) — ignore
        }
      }
    });
    return () => subscription.remove();
  }, []);

  // Handle Home Screen Quick Actions (3D Touch / Haptic Touch shortcuts).
  // beebeeb://photos / shared / settings are handled by React Navigation's
  // linking config; beebeeb://upload and beebeeb://search bypass it so they
  // can pass an `action` param into Files (the screen reads + clears it).
  useEffect(() => {
    const handleShortcutURL = (url: string | null) => {
      if (!url) return;
      let action: 'upload' | 'search' | 'scan' | 'recent' | null = null;
      if (url === 'beebeeb://upload') action = 'upload';
      else if (url === 'beebeeb://search') action = 'search';
      else if (url === 'beebeeb://scan') action = 'scan';
      else if (url === 'beebeeb://recent') action = 'recent';
      const dispatch = () => {
        if (!navigationRef.isReady()) return;
        if (isBackupInsightsURL(url)) {
          navigationRef.navigate('BackupInsights');
          return;
        }
        if (!action) return;
        // The Tabs route's deep-nested signature isn't easy to express in
        // RootStackParamList without leaking nav internals; the runtime
        // shape `{ screen, params }` is what react-navigation expects, and
        // navigationRef.navigate is permissive at runtime.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigationRef.navigate as any)('Tabs', {
          screen: 'Files',
          params: { action },
        });
      };
      // Cold-launch URLs may arrive before the container is mounted; retry
      // for a short window; Live Activity taps can arrive before auth restore
      // has mounted the authenticated stack.
      if (action || isBackupInsightsURL(url)) {
        dispatchWhenNavigationReady(dispatch);
      }
    };

    Linking.getInitialURL().then(handleShortcutURL).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => handleShortcutURL(url));
    return () => sub.remove();
  }, []);

  // Capture #key= fragments from share URLs before React Navigation routing
  // strips the hash. The fragment is stored in share-key-store.ts and consumed
  // by SharedViewScreen on mount so the "Download in browser" CTA can open the
  // full URL (including key) in Safari.
  useEffect(() => {
    function captureShareFragment(url: string | null): void {
      if (!url) return;
      const hashIdx = url.indexOf('#');
      if (hashIdx === -1) return;
      const fragment = url.slice(hashIdx + 1);
      const params = new URLSearchParams(fragment);
      const shareKey = params.get('key');
      if (!shareKey) return;
      const tokenMatch = /\/s\/([^/?#]+)/.exec(url);
      if (tokenMatch) {
        setPendingShareKey(tokenMatch[1], shareKey);
      }
    }
    Linking.getInitialURL().then(captureShareFragment).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => captureShareFragment(url));
    return () => sub.remove();
  }, []);

  // Called from SignupScreen when OPAQUE registration succeeds and the
  // recovery-phrase onboarding is about to start. Prevents the welcome overlay
  // from covering the phrase flow and marks phrase verification as pending.
  const skipOnboarding = useCallback((phrase?: string[]) => {
    setOnboardingDone(true);
    setPhraseVerified(false);
    setPendingRecoveryPhrase(phrase && phrase.length > 0 ? phrase : null);
    SecureStore.setItemAsync(ONBOARDING_KEY, 'true').catch(() => {});
    SecureStore.setItemAsync(PHRASE_VERIFIED_KEY, 'pending').catch(() => {});
  }, []);

  // Called from RecoveryPhraseVerifyScreen on successful word verification.
  const markPhraseVerified = useCallback(async () => {
    try {
      await SecureStore.setItemAsync(PHRASE_VERIFIED_KEY, 'verified');
    } catch { /* SecureStore unavailable (web) */ }
    setPhraseVerified(true);
    setPendingRecoveryPhrase(null);
  }, []);

  const isAuthenticated = user !== null;

  useEffect(() => {
    if (!isAuthenticated || phraseVerified || !pendingRecoveryPhrase || !navReady) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      if (!navigationRef.isReady()) return;
      const route = navigationRef.getCurrentRoute()?.name;
      if (route === 'RecoveryPhrase' || route === 'RecoveryPhraseVerify') {
        clearInterval(interval);
        return;
      }
      navigationRef.navigate('RecoveryPhrase', { phrase: pendingRecoveryPhrase });
      if (attempts >= 10) clearInterval(interval);
    }, 250);
    return () => clearInterval(interval);
  }, [isAuthenticated, navReady, pendingRecoveryPhrase, phraseVerified]);

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

  // Loading splash while checking auth, or diagnostic panel when server is unreachable
  if (checking || showDiagnostics) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: c.paper, alignItems: 'center', justifyContent: 'center', paddingHorizontal: showDiagnostics ? 0 : 32 }}>
          <BBLogo size={48} />
          <View style={{ height: 20 }} />
          {showDiagnostics ? (
            <DiagnosticPanel
              onRetry={() => void runStartup()}
              onSignIn={() => {
                setShowDiagnostics(false);
                setChecking(false);
                setUser(null);
              }}
            />
          ) : (
            <>
              {!loadingFailed && <ActivityIndicator color={c.ink3} />}
              {loadingStatus ? (
                <Text style={{ color: c.ink3, fontSize: 13, marginTop: 12, textAlign: 'center' }}>
                  {loadingStatus}
                </Text>
              ) : null}
              {loadingFailed ? (
                <View style={{ alignItems: 'center', marginTop: 8 }}>
                  <Text style={{ color: c.red, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
                    Something went wrong
                  </Text>
                  <Text style={{ color: c.ink3, fontSize: 13, marginTop: 6, textAlign: 'center', lineHeight: 18 }}>
                    We couldn't reach our servers.{'\n'}Check status.beebeeb.io for updates.
                  </Text>
                </View>
              ) : null}
            </>
          )}
        </View>
        <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      </SafeAreaProvider>
    );
  }

  return (
    <AuthContext.Provider value={{ user, refreshAuth, signOut, phraseVerified, skipOnboarding, markPhraseVerified }}>
      <CryptoProvider key={user?.user_id ?? 'signed-out'}>
      <SafeAreaProvider>
      <SyncProvider>
      <ToastProvider>
      <BackupProvider>
        <NavigationContainer
          ref={navigationRef}
          linking={linking}
          onReady={() => setNavReady(true)}
          onStateChange={handleNavigationStateChange}
        >
            <VaultRecoveryGate enabled={isAuthenticated} navReady={navReady} />
            <DevicePerformanceCalibrator enabled={isAuthenticated && !locked} />
            <ThumbnailRepairWorker enabled={isAuthenticated && !locked} />
            <FileProviderDomainRegistrar enabled={isAuthenticated && !locked} />
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              {isAuthenticated ? (
                <>
                  <Stack.Screen name="Tabs" component={TabNavigator} />
                  <Stack.Screen
                    name="RecoveryUnlock"
                    component={RecoveryUnlockScreen}
                    options={{ gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="Preview"
                    component={PreviewScreen}
                    // 'modal' (not 'fullScreenModal') so iOS gives users the
                    // native swipe-down-to-dismiss gesture — runbook expects
                    // it and there's no PanResponder fallback inside Preview.
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
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
                  <Stack.Screen name="Privacy" component={PrivacyScreen} options={{ headerShown: false }} />
                  <Stack.Screen name="Storage" component={StorageScreen} options={{ headerShown: false }} />
                  <Stack.Screen
                    name="RecoveryPhrase"
                    component={OnboardingScreen}
                    options={{ gestureEnabled: false }}
                  />
                  <Stack.Screen
                    name="RecoveryPhraseVerify"
                    component={RecoveryPhraseVerifyScreen}
                    options={{ gestureEnabled: false }}
                  />
                  <Stack.Screen name="DevicePairing" component={DevicePairingScreen} />
                  <Stack.Screen name="DevicePairingScan" component={DevicePairingScanScreen} />
                  <Stack.Screen name="DevicePairingShow" component={DevicePairingShowScreen} />
                  <Stack.Screen name="PairingConfirm" component={PairingConfirmScreen} />
                  <Stack.Screen
                    name="ConstellationSend"
                    component={ConstellationSendScreen}
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen
                    name="DocumentScanner"
                    component={DocumentScannerScreen}
                    options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                  />
                  <Stack.Screen
                    name="TwoFactorSetup"
                    component={TwoFactorSetupScreen}
                    options={{ title: 'Two-Factor Authentication', headerShown: false }}
                  />
                  <Stack.Screen
                    name="BackupInsights"
                    component={BackupInsightsScreen}
                    options={{ headerShown: false }}
                  />
                  <Stack.Screen
                    name="Speedtest"
                    component={SpeedtestScreen}
                    options={{ headerShown: false }}
                  />
                  <Stack.Screen
                    name="AdvancedSettings"
                    component={AdvancedSettingsScreen}
                    options={{ headerShown: false }}
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

        {/* Offline banner */}
        {!isConnected && <OfflineBanner />}

        {/* Onboarding overlay — shown once after first signup */}
        {isAuthenticated && !onboardingDone && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: c.paper2 }}>
            <OnboardingScreen
              onComplete={async () => {
                try {
                  await SecureStore.setItemAsync(ONBOARDING_KEY, 'true');
                } catch { /* web */ }
                setOnboardingDone(true);
              }}
            />
          </View>
        )}

        {/* Biometric lock overlay — shown when app resumes from background */}
        {isAuthenticated && (
          <BiometricGuard locked={locked} onUnlock={() => { markUnlocked(); setLocked(false); }} />
        )}

        {/* Share Extension dropbox — uploads files dropped by BeebeebShare */}
        <ShareSheetImporter enabled={isAuthenticated && !locked} />

        {/* Android-only password prompt for step-up re-auth (no-op on iOS) */}
        <ConfirmActionPrompt />

        <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      </BackupProvider>
      </ToastProvider>
      </SyncProvider>
      </SafeAreaProvider>
      </CryptoProvider>
    </AuthContext.Provider>
  );
}

function AppWithErrorBoundary() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

function DevicePerformanceCalibrator({ enabled }: { enabled: boolean }) {
  const crypto = useCrypto();

  useEffect(() => {
    if (!enabled || !crypto.isUnlocked) return;
    const timer = setTimeout(() => {
      void ensureDevicePerformanceProfile(crypto).catch(() => null);
    }, 2500);
    return () => clearTimeout(timer);
  }, [crypto, enabled]);

  return null;
}

registerRootComponent(AppWithErrorBoundary);
