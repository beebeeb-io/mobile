import React from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { colors, radii, spacing } from '../theme';

// ---------------------------------------------------------------------------
// Settings data
// ---------------------------------------------------------------------------

interface SettingsItem {
  icon: string;
  label: string;
  sub?: string;
  value?: string;
  hero?: boolean;
  toggle?: boolean;
  toggleOn?: boolean;
  danger?: boolean;
}

interface SettingsGroup {
  label?: string;
  items: SettingsItem[];
}

const GROUPS: SettingsGroup[] = [
  {
    items: [
      {
        icon: '👤',
        label: 'Isa Marchetti',
        sub: 'isa@example.com · Team · 23.4 / 200 GB',
        hero: true,
      },
    ],
  },
  {
    label: 'Security',
    items: [
      { icon: '🔒', label: 'Biometrics', value: 'Face ID' },
      { icon: '🛡️', label: 'Two-factor', value: 'Passkey + backup' },
      { icon: '🔑', label: 'Recovery phrase', value: 'Exported 4 weeks ago' },
      { icon: '☁️', label: 'Devices', value: '5' },
      { icon: '🔒', label: 'Lock app on leave', value: 'Immediately' },
    ],
  },
  {
    label: 'Backup',
    items: [
      { icon: '🖼️', label: 'Camera roll', value: 'On · Wi-Fi only' },
      { icon: '↑', label: 'Background upload', toggle: true, toggleOn: true },
      { icon: '📁', label: 'Files app integration', toggle: true, toggleOn: true },
    ],
  },
  {
    label: 'App',
    items: [
      { icon: '⚙️', label: 'Appearance', value: 'System' },
      { icon: '⭐', label: 'Language', value: 'English' },
      { icon: '🕒', label: 'Clear local cache', value: '1.4 GB' },
    ],
  },
  {
    items: [
      { icon: '🔒', label: 'Sign out', danger: true },
    ],
  },
];

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Settings</Text>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {GROUPS.map((group, gi) => (
          <View key={gi} style={styles.group}>
            {group.label && <Text style={styles.groupLabel}>{group.label}</Text>}
            <View style={styles.card}>
              {group.items.map((item, ii) => (
                <TouchableOpacity
                  key={ii}
                  style={[
                    styles.row,
                    ii < group.items.length - 1 ? styles.rowBorder : undefined,
                    item.hero ? styles.rowHero : undefined,
                  ]}
                  activeOpacity={0.6}
                >
                  {/* Icon */}
                  {item.hero ? (
                    <View style={styles.avatarCircle}>
                      <Text style={styles.avatarText}>IM</Text>
                    </View>
                  ) : (
                    <View style={styles.iconBox}>
                      <Text style={[styles.iconEmoji, item.danger ? { color: colors.red } : undefined]}>
                        {item.icon}
                      </Text>
                    </View>
                  )}

                  {/* Label + subtitle */}
                  <View style={styles.labelCol}>
                    <Text
                      style={[
                        styles.label,
                        item.hero ? styles.labelHero : undefined,
                        item.danger ? { color: colors.red } : undefined,
                      ]}
                    >
                      {item.label}
                    </Text>
                    {item.sub && <Text style={styles.sub}>{item.sub}</Text>}
                  </View>

                  {/* Value / toggle / chevron */}
                  {item.value && <Text style={styles.value}>{item.value}</Text>}
                  {item.toggle && (
                    <Switch
                      value={item.toggleOn}
                      trackColor={{ false: colors.line2, true: colors.amber }}
                      thumbColor={colors.paper}
                      style={{ transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }] }}
                    />
                  )}
                  {!item.toggle && !item.danger && (
                    <Text style={styles.chevron}>{'›'}</Text>
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}

        {/* App version footer */}
        <View style={styles.footer}>
          <Text style={styles.footerVersion}>v1.2.0 {'·'} build 442</Text>
          <Text style={styles.footerRegion}>beebeeb.io {'·'} Frankfurt</Text>
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
  scrollContent: { paddingHorizontal: 14, paddingBottom: 30 },

  // Group
  group: { marginBottom: 14 },
  groupLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 6,
    marginBottom: 6,
  },
  card: {
    backgroundColor: colors.paper,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 9,
    paddingHorizontal: 12,
    gap: 10,
  },
  rowHero: { paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },

  // Icon
  avatarCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.amberDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.paper, fontSize: 12, fontWeight: '700' },
  iconBox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconEmoji: { fontSize: 11 },

  // Label
  labelCol: { flex: 1, minWidth: 0 },
  label: { fontSize: 13, fontWeight: '500', color: colors.ink },
  labelHero: { fontWeight: '600' },
  sub: { fontSize: 10, color: colors.ink3, marginTop: 2 },

  // Value
  value: { fontSize: 11, color: colors.ink3 },
  chevron: { fontSize: 16, color: colors.ink4 },

  // Footer
  footer: { alignItems: 'center', paddingVertical: 10 },
  footerVersion: { fontSize: 10, color: colors.ink4 },
  footerRegion: { fontSize: 10, color: colors.amberDeep, marginTop: 2 },
});
