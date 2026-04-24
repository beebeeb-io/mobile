import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

/**
 * Shared tab -- placeholder screen.
 * Full implementation will list files shared with the current user.
 */
export default function SharedScreen() {
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Shared</Text>
      <View style={styles.empty}>
        <Text style={styles.emptyIcon}>{'👥'}</Text>
        <Text style={styles.emptyTitle}>Nothing shared yet</Text>
        <Text style={styles.emptyBody}>
          Files shared with you will appear here.{'\n'}
          End-to-end encrypted -- the server never sees your data.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    paddingHorizontal: spacing.lg,
    paddingTop: 6,
    paddingBottom: 10,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyIcon: { fontSize: 32, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: colors.ink, marginBottom: 8 },
  emptyBody: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 20,
  },
});
