import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../App';
import { colors, radii, spacing } from '../theme';

type SharedViewRoute = RouteProp<RootStackParamList, 'SharedView'>;
type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function SharedViewScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<SharedViewRoute>();
  const insets = useSafeAreaInsets();
  const { token } = route.params;

  const handleClose = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Tabs');
    }
  }, [navigation]);

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.closeText}>{'×'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Shared file</Text>
        <View style={{ width: 32 }} />
      </View>

      <View style={styles.body}>
        <View style={styles.iconBox}>
          <Text style={styles.iconText}>FILE</Text>
        </View>
        <Text style={styles.heading}>Encrypted share</Text>
        <Text style={styles.sub}>
          This file was shared with you via a Beebeeb link. Crypto bindings are required to decrypt and open it — UniFFI integration is in progress.
        </Text>

        <View style={styles.tokenCard}>
          <Text style={styles.tokenLabel}>Share token</Text>
          <Text style={styles.tokenValue} numberOfLines={1}>{token}</Text>
        </View>

        <View style={styles.encBadge}>
          <View style={styles.encDot} />
          <Text style={styles.encText}>End-to-end encrypted · AES-256-GCM</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.paper2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { fontSize: 18, color: colors.ink2 },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '600',
    color: colors.ink,
  },

  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconBox: {
    width: 72,
    height: 72,
    borderRadius: 18,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  iconText: {
    color: colors.amber,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.3,
  },
  sub: {
    fontSize: 13,
    color: colors.ink3,
    textAlign: 'center',
    lineHeight: 19,
  },
  tokenCard: {
    width: '100%',
    backgroundColor: colors.paper,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
    marginTop: 8,
  },
  tokenLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.ink3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tokenValue: {
    fontSize: 13,
    fontFamily: 'Courier',
    color: colors.ink2,
  },
  encBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  encDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.amber,
  },
  encText: { fontSize: 11, color: colors.ink3 },
});
