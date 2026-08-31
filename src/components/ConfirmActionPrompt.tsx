/**
 * Android-only password prompt for step-up re-auth.
 *
 * iOS uses native `Alert.prompt` directly. Android has no equivalent, so we
 * mount this component once near the root (App.tsx) and let `confirm-action.ts`
 * drive it via `registerAndroidConfirmPrompter`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { radii, shadows } from '../theme';
import { useTheme } from '../lib/theme-context';
import { registerAndroidConfirmPrompter } from '../lib/confirm-action';

interface PendingPrompt {
  title: string;
  message: string;
  resolve: (password: string | null) => void;
}

export default function ConfirmActionPrompt() {
  const { colors: c } = useTheme();
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const [password, setPassword] = useState('');
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    registerAndroidConfirmPrompter(
      (title, message) =>
        new Promise<string | null>((resolve) => {
          setPassword('');
          setPending({ title, message, resolve });
        }),
    );
    return () => registerAndroidConfirmPrompter(null);
  }, []);

  const close = useCallback((value: string | null) => {
    setPending((p) => {
      p?.resolve(value);
      return null;
    });
    setPassword('');
  }, []);

  if (Platform.OS !== 'android' || !pending) return null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => close(null)}
    >
      <KeyboardAvoidingView style={styles.overlay} behavior={undefined}>
        <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={() => close(null)} />
        <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
          <Text style={[styles.title, { color: c.ink }]}>{pending.title}</Text>
          <Text style={[styles.body, { color: c.ink3 }]}>{pending.message}</Text>
          <TextInput
            ref={inputRef}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={c.ink4}
            secureTextEntry
            autoFocus
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="done"
            onSubmitEditing={() => password && close(password)}
            style={[styles.input, { color: c.ink, borderColor: c.line2, backgroundColor: c.paper2 }]}
            accessibilityLabel="Password"
          />
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.secondary}
              onPress={() => close(null)}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={[styles.secondaryText, { color: c.ink2 }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primary, { backgroundColor: c.red, opacity: password ? 1 : 0.5 }]}
              onPress={() => password && close(password)}
              disabled={!password}
              accessibilityRole="button"
              accessibilityLabel="Confirm"
            >
              <Text style={[styles.primaryText, { color: '#fff' }]}>Confirm</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24 },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: 20,
    gap: 12,
    ...shadows.lg,
  },
  title: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 13 },
  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 4 },
  secondary: { paddingVertical: 8, paddingHorizontal: 12 },
  secondaryText: { fontSize: 15, fontWeight: '500' },
  primary: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: radii.md },
  primaryText: { fontSize: 15, fontWeight: '600' },
});
