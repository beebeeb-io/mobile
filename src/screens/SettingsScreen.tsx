import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { colors, radii, spacing } from '../theme';
import { useAuth } from '../lib/auth';
import { getStorageUsage, type StorageUsage } from '../lib/api';

const BIOMETRIC_PREF_KEY = 'beebeeb_biometric_lock';
const CAMERA_BACKUP_KEY = 'beebeeb_camera_backup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function userInitials(email: string): string {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return local.slice(0, 2).toUpperCase();
}

function planLabel(name: string): string {
  const map: Record<string, string> = {
    free: 'Free',
    personal: 'Personal',
    team: 'Team',
    business: 'Business',
  };
  return map[name.toLowerCase()] ?? name;
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

function SettingsRow({
  label,
  value,
  onPress,
  danger,
  showChevron = true,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  showChevron?: boolean;
}) {
  return (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={onPress ? 0.6 : 1}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text style={[styles.rowLabel, danger && { color: colors.red }]}>
        {label}
      </Text>
      <View style={styles.rowRight}>
        {value != null && <Text style={styles.rowValue}>{value}</Text>}
        {showChevron && !danger && (
          <Text style={styles.chevron}>{'›'}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

function ToggleRow({
  label,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.line, true: colors.amber }}
        thumbColor={colors.paper}
        ios_backgroundColor={colors.line}
      />
    </View>
  );
}

function RowDivider() {
  return <View style={styles.rowDivider} />;
}

// ---------------------------------------------------------------------------
// Storage bar
// ---------------------------------------------------------------------------

function StorageBar({
  usedBytes,
  limitBytes,
}: {
  usedBytes: number;
  limitBytes: number;
}) {
  const pct = limitBytes > 0 ? Math.min(usedBytes / limitBytes, 1) : 0;
  const barColor = pct > 0.9 ? colors.red : pct > 0.75 ? colors.amberDeep : colors.amber;

  return (
    <View style={styles.storageBarContainer}>
      <View style={styles.storageBarTrack}>
        <View
          style={[
            styles.storageBarFill,
            { width: `${Math.max(pct * 100, 1)}%`, backgroundColor: barColor },
          ]}
        />
      </View>
      <Text style={styles.storageBarLabel}>
        {formatBytes(usedBytes)} of {formatBytes(limitBytes)} used
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);

  // Biometric lock preference
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [loadingBiometric, setLoadingBiometric] = useState(true);

  // Notifications preference (stored locally)
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);

  // Camera roll backup preference
  const [cameraBackupEnabled, setCameraBackupEnabled] = useState(false);

  const fetchUsage = useCallback(async () => {
    try {
      const data = await getStorageUsage();
      setUsage(data);
    } catch {
      // Usage endpoint may not be available yet; show graceful fallback
    } finally {
      setLoadingUsage(false);
    }
  }, []);

  const loadBiometricPrefs = useCallback(async () => {
    try {
      const supported = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(supported && enrolled);

      const stored = await SecureStore.getItemAsync(BIOMETRIC_PREF_KEY);
      setBiometricEnabled(stored === 'true');

      const camStored = await SecureStore.getItemAsync(CAMERA_BACKUP_KEY);
      setCameraBackupEnabled(camStored === 'true');
    } catch {
      // Biometrics unavailable on this device/platform
    } finally {
      setLoadingBiometric(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
    loadBiometricPrefs();
  }, [fetchUsage, loadBiometricPrefs]);

  const handleBiometricToggle = useCallback(async (enabled: boolean) => {
    if (enabled) {
      // Verify biometrics work before enabling
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm your identity to enable Face ID lock',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (!result.success) return;
    }
    setBiometricEnabled(enabled);
    await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, enabled ? 'true' : 'false');
  }, []);

  const handleNotificationsToggle = useCallback((enabled: boolean) => {
    setNotificationsEnabled(enabled);
    // Notification permission request would go here
  }, []);

  const handleCameraBackupToggle = useCallback(async (enabled: boolean) => {
    setCameraBackupEnabled(enabled);
    await SecureStore.setItemAsync(CAMERA_BACKUP_KEY, enabled ? 'true' : 'false');
  }, []);

  const handleSignOut = useCallback(() => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => signOut(),
      },
    ]);
  }, [signOut]);

  const email = user?.email ?? '';
  const initials = userInitials(email);

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Settings</Text>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ---- Account ---- */}
        <View style={styles.section}>
          <View style={styles.card}>
            <TouchableOpacity style={styles.accountRow} activeOpacity={0.6}>
              <View style={styles.avatarCircle}>
                <Text style={styles.avatarText}>{initials}</Text>
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.accountEmail} numberOfLines={1}>
                  {email}
                </Text>
                {user?.created_at && (
                  <Text style={styles.accountSub}>
                    Member since {formatDate(user.created_at)}
                  </Text>
                )}
              </View>
              <Text style={styles.chevron}>{'›'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ---- Storage ---- */}
        <View style={styles.section}>
          <SectionHeader title="Storage" />
          <View style={styles.card}>
            {loadingUsage ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.ink4} />
              </View>
            ) : usage ? (
              <>
                <View style={styles.storageRow}>
                  <StorageBar
                    usedBytes={usage.used_bytes}
                    limitBytes={usage.plan_limit_bytes}
                  />
                </View>
                <RowDivider />
                <SettingsRow
                  label="Plan"
                  value={planLabel(usage.plan_name)}
                  showChevron={true}
                />
              </>
            ) : (
              <View style={styles.storageRow}>
                <Text style={styles.rowValue}>Could not load storage info</Text>
              </View>
            )}
          </View>
        </View>

        {/* ---- Security ---- */}
        <View style={styles.section}>
          <SectionHeader title="Security" />
          <View style={styles.card}>
            {!loadingBiometric && biometricAvailable && (
              <>
                <ToggleRow
                  label="Face ID lock"
                  value={biometricEnabled}
                  onValueChange={handleBiometricToggle}
                />
                <RowDivider />
              </>
            )}
            <SettingsRow label="Change password" />
            <RowDivider />
            <SettingsRow label="Two-factor authentication" />
          </View>
        </View>

        {/* ---- Backup ---- */}
        <View style={styles.section}>
          <SectionHeader title="Backup" />
          <View style={styles.card}>
            <ToggleRow
              label="Back up camera roll"
              value={cameraBackupEnabled}
              onValueChange={handleCameraBackupToggle}
            />
            {cameraBackupEnabled && (
              <>
                <RowDivider />
                <View style={styles.backupNote}>
                  <Text style={styles.backupNoteText}>
                    Camera backup will be available once native crypto bindings are integrated.
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* ---- Notifications ---- */}
        <View style={styles.section}>
          <SectionHeader title="Notifications" />
          <View style={styles.card}>
            <ToggleRow
              label="Push notifications"
              value={notificationsEnabled}
              onValueChange={handleNotificationsToggle}
            />
          </View>
        </View>

        {/* ---- Appearance ---- */}
        <View style={styles.section}>
          <SectionHeader title="Appearance" />
          <View style={styles.card}>
            <SettingsRow label="Theme" value="System" showChevron={true} />
          </View>
        </View>

        {/* ---- About ---- */}
        <View style={styles.section}>
          <SectionHeader title="About" />
          <View style={styles.card}>
            <SettingsRow label="Version" value="1.0.0" showChevron={false} />
            <RowDivider />
            <SettingsRow label="Website" value="beebeeb.io" showChevron={false} />
            <RowDivider />
            <SettingsRow
              label="Operator"
              value="Initlabs B.V."
              showChevron={false}
            />
          </View>
        </View>

        {/* ---- Sign out ---- */}
        <View style={styles.section}>
          <View style={styles.card}>
            <SettingsRow
              label="Sign out"
              danger
              showChevron={false}
              onPress={handleSignOut}
            />
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
            End-to-end encrypted. Zero knowledge.
          </Text>
          <Text style={styles.footerText}>Made in Europe.</Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper2 },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    paddingHorizontal: spacing.lg,
    paddingTop: 6,
    paddingBottom: 10,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 14, paddingBottom: 40 },

  // Section
  section: { marginBottom: 14 },
  sectionHeader: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    marginBottom: 6,
  },

  // Card
  card: {
    backgroundColor: colors.paper,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },

  // Account hero row
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 10,
  },
  avatarCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.amber,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  accountInfo: { flex: 1, minWidth: 0 },
  accountEmail: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.ink,
  },
  accountSub: {
    fontSize: 11,
    color: colors.ink3,
    marginTop: 2,
  },

  // Generic row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '400',
    color: colors.ink,
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  rowValue: {
    fontSize: 13,
    color: colors.ink3,
  },
  rowDivider: {
    height: 1,
    backgroundColor: colors.line,
    marginLeft: 12,
  },
  chevron: {
    fontSize: 18,
    color: colors.ink4,
    marginLeft: 2,
  },

  // Loading
  loadingRow: {
    paddingVertical: 18,
    alignItems: 'center',
  },

  // Storage
  storageRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  storageBarContainer: {
    gap: 6,
  },
  storageBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  storageBarFill: {
    height: '100%',
    borderRadius: 3,
  },
  storageBarLabel: {
    fontSize: 11,
    color: colors.ink3,
  },

  // Backup note
  backupNote: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  backupNoteText: {
    fontSize: 12,
    color: colors.ink3,
    lineHeight: 17,
  },

  // Footer
  footer: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 2,
  },
  footerText: {
    fontSize: 10,
    color: colors.ink4,
  },
});
