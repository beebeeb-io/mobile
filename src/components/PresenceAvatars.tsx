import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../lib/theme-context';

export interface PresenceUser {
  id: string;
  email: string;
  initials: string;
}

const PALETTE = ['#e67e22', '#3498db', '#2ecc71', '#9b59b6', '#e74c3c', '#1abc9c'];

function hashColor(email: string): string {
  let hash = 0;
  for (const ch of email) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

const MAX_VISIBLE = 3;

export default function PresenceAvatars({ users }: { users: PresenceUser[] }) {
  const { colors: c } = useTheme();
  if (users.length === 0) return null;

  const visible = users.slice(0, MAX_VISIBLE);
  const overflow = users.length - MAX_VISIBLE;

  return (
    <View
      style={styles.row}
      accessibilityLabel={
        users.length === 1
          ? `${users[0]!.email} is here`
          : `${users.length} people are here`
      }
    >
      {visible.map((user, i) => (
        <View
          key={user.id}
          style={[
            styles.avatar,
            {
              backgroundColor: hashColor(user.email),
              borderColor: c.paper,
              marginLeft: i > 0 ? -10 : 0,
              zIndex: 10 - i,
            },
          ]}
        >
          <Text style={styles.initials}>{user.initials}</Text>
        </View>
      ))}
      {overflow > 0 && (
        <View
          style={[
            styles.avatar,
            styles.overflow,
            {
              backgroundColor: c.ink3,
              borderColor: c.paper,
            },
          ]}
        >
          <Text style={styles.overflowText}>+{overflow}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  initials: { color: '#fff', fontSize: 10, fontWeight: '700' },
  overflow: { marginLeft: -10 },
  overflowText: { color: '#fff', fontSize: 10, fontWeight: '600' },
});
