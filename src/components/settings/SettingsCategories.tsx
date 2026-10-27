import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { type Colors, typeScale } from '../../theme';
import type { SettingsAttention } from '../../lib/settings-attention';

export const SETTINGS_CATEGORIES = [
  { id: 'account', title: 'Account', description: 'Your account and storage use', icon: 'person-outline' },
  { id: 'security', title: 'Security', description: 'App lock, sign-in and devices', icon: 'shield-checkmark-outline' },
  { id: 'backups', title: 'Backups & files', description: 'Phone backups, photos and file access', icon: 'cloud-upload-outline' },
  { id: 'notifications', title: 'Notifications', description: 'Account alerts and reminders on this device', icon: 'notifications-outline' },
  { id: 'appearance', title: 'Appearance', description: 'Light, dark or your system theme', icon: 'contrast-outline' },
  { id: 'privacy', title: 'Privacy & data', description: 'Activity tracking, export and account deletion', icon: 'hand-left-outline' },
  { id: 'storage', title: 'Storage location', description: 'Where new uploads are stored', icon: 'globe-outline' },
  { id: 'help', title: 'Help & about', description: 'Support, app information and legal documents', icon: 'help-circle-outline' },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id'];

export function SettingsCategory({ id, active, children }: {
  id: SettingsCategoryId;
  active: SettingsCategoryId | null;
  children: React.ReactNode;
}) {
  return active === id ? <>{children}</> : null;
}

export function SettingsCategoryList({ colors: c, backgroundColor, onSelect, attention }: {
  colors: Colors;
  backgroundColor: string;
  onSelect: (id: SettingsCategoryId) => void;
  /**
   * Task 2245 (P1): the SAME attention object that drives the tab badge.
   * A reason replaces its row's description and adds the "!" marker before
   * the chevron, in the existing warning token.
   */
  attention?: SettingsAttention;
}) {
  return (
    <View style={{ borderRadius: 26, overflow: 'hidden', backgroundColor }}>
      {SETTINGS_CATEGORIES.map((category, index) => {
        const reason = attention?.reasons.find((entry) => entry.id === category.id);
        return (
          <TouchableOpacity
            key={category.id}
            testID={`settings-category-${category.id}`}
            accessibilityRole="button"
            accessibilityLabel={category.title}
            accessibilityHint={reason?.message ?? category.description}
            onPress={() => onSelect(category.id)}
            style={{ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingHorizontal: 16, paddingVertical: 12, gap: 12, borderTopWidth: index === 0 ? 0 : 0.5, borderTopColor: c.line }}
          >
            <Ionicons name={category.icon} size={20} color={c.ink3} />
            <View style={{ flex: 1 }}>
              <Text style={[typeScale.body, { color: c.ink }]}>{category.title}</Text>
              <Text style={{ fontSize: 12, color: reason ? c.amberDeep : c.ink3, marginTop: 3 }}>
                {reason?.message ?? category.description}
              </Text>
            </View>
            {reason ? (
              <Text
                testID={`settings-category-${category.id}-attention`}
                accessibilityElementsHidden
                importantForAccessibility="no"
                style={{ fontSize: 13, fontWeight: '700' as const, color: c.amberDeep }}
              >
                !
              </Text>
            ) : null}
            <Ionicons name="chevron-forward" size={16} color={c.ink4} />
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
