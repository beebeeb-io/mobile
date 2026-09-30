/**
 * The app's own password-prompt sheet for step-up re-auth (task 1610,
 * Issue 2 round 2) — every platform drives THIS, never a native `Alert`.
 *
 * Mounted once near the root (App.tsx) and driven by `../lib/confirm-
 * action.ts` via `registerConfirmPrompter`: that module hands it a
 * `{ title, message, attempt }` request per `requestConfirmation()` call,
 * where `attempt(password)` does the actual `confirmAction` API call and
 * reports back whether it succeeded, wants a retry (wrong password — shown
 * IN PLACE, no close/reopen cycle), or is fatal (session too old, or
 * anything else `confirmAction` can throw — shown in place of the password
 * field; the only way out is to dismiss).
 *
 * Built on the shared `BottomSheet` (task 1586) — the same sheet primitive
 * `NewFileSheet`/`TrustDetailsSheet`/the Info sheet render through — for the
 * same look everywhere a sheet appears, not a bespoke centered dialog.
 *
 * Race safety: `requestConfirmation()`'s promise is resolved from
 * `BottomSheet`'s `onDismissed` — i.e. only once the close ANIMATION has
 * actually finished — never from the button press that decided the
 * outcome. A caller that navigates the instant it gets its token (or its
 * `null`) can never race a still-presenting/dismissing sheet; that is the
 * same bug class Issue 2's `handleDisabled` black screen was (see
 * TwoFactorSetupScreen.tsx's comment there), enforced here once for every
 * step-up caller instead of per call site.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { radii } from '../theme';
import { BottomSheet, BottomSheetScrollView } from './sheet/BottomSheet';
import { useTheme } from '../lib/theme-context';
import {
  registerConfirmPrompter,
  type ConfirmAttemptOutcome,
  type ConfirmPromptRequest,
} from '../lib/confirm-action';

type Phase = 'input' | 'submitting' | 'fatal';

interface Pending extends ConfirmPromptRequest {
  resolve: (token: string | null) => void;
}

export default function ConfirmActionPrompt() {
  const { colors: c } = useTheme();

  const [pending, setPending] = useState<Pending | null>(null);
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>('input');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [fatalTitle, setFatalTitle] = useState('');

  // The token/null a settled attempt decided on — read by `onDismissed`,
  // which is the ONLY place the caller's promise is actually resolved.
  const resultRef = useRef<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    registerConfirmPrompter(
      (request) =>
        new Promise<string | null>((resolve) => {
          resultRef.current = null;
          setPending({ ...request, resolve });
          setPhase('input');
          setPassword('');
          setMessage(request.message);
          setFatalTitle('');
          setMounted(true);
          setVisible(true);
        }),
    );
    return () => registerConfirmPrompter(null);
  }, []);

  // Decide the outcome and start the close animation; the actual resolve
  // happens later, in `onDismissed`.
  const finish = useCallback((token: string | null) => {
    resultRef.current = token;
    setVisible(false);
  }, []);

  const onDismissed = useCallback(() => {
    setMounted(false);
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(resultRef.current);
  }, []);

  const cancel = useCallback(() => finish(null), [finish]);

  const submit = useCallback(async () => {
    const current = pendingRef.current;
    if (!current || !password || phase === 'submitting') return;
    setPhase('submitting');
    let outcome: ConfirmAttemptOutcome;
    try {
      outcome = await current.attempt(password);
    } catch {
      // `attempt()` is documented (confirm-action.ts) to always catch and
      // report an outcome rather than throw — fail closed here too, rather
      // than leave the sheet stuck mid-submit forever, in case a future
      // caller doesn't hold that contract.
      setFatalTitle('Confirmation failed');
      setMessage('Something went wrong. Please try again.');
      setPhase('fatal');
      return;
    }
    if (outcome.ok) {
      finish(outcome.token);
      return;
    }
    if (outcome.retry) {
      setPassword('');
      setMessage(outcome.message);
      setPhase('input');
      return;
    }
    setFatalTitle(outcome.title);
    setMessage(outcome.message);
    setPhase('fatal');
  }, [password, phase, finish]);

  if (!mounted || !pending) return null;

  const canSubmit = phase === 'input' && password.length > 0;

  return (
    <Modal visible transparent statusBarTranslucent animationType="none" onRequestClose={cancel}>
      <GestureHandlerRootView style={styles.fill}>
        <BottomSheet
          visible={visible}
          onRequestClose={cancel}
          onDismissed={onDismissed}
          detents={['half']}
          initialDetent="half"
          avoidKeyboard
          contentStyle={styles.content}
          handleAccessibilityLabel="Password prompt"
          scrimAccessibilityLabel="Cancel"
          testID="confirm-action-prompt"
        >
          <BottomSheetScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scrollBody}>
            <Text style={[styles.title, { color: c.ink }]} accessibilityRole="header">
              {phase === 'fatal' ? fatalTitle : pending.title}
            </Text>
            <Text style={[styles.body, { color: c.ink3 }]} accessibilityLiveRegion="polite">
              {message}
            </Text>

            {phase !== 'fatal' ? (
              <TextInput
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={c.ink4}
                secureTextEntry
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
                returnKeyType="done"
                editable={phase !== 'submitting'}
                onSubmitEditing={() => void submit()}
                style={[styles.input, { color: c.ink, borderColor: c.line2, backgroundColor: c.paper2 }]}
                accessibilityLabel="Password"
                testID="confirm-action-password-input"
              />
            ) : null}

            <View style={styles.actions}>
              {phase === 'fatal' ? (
                <TouchableOpacity
                  style={[styles.primary, { backgroundColor: c.amber }]}
                  onPress={cancel}
                  accessibilityRole="button"
                  accessibilityLabel="OK"
                  testID="confirm-action-ok"
                >
                  <Text style={[styles.primaryText, { color: c.black }]}>OK</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.secondary}
                    onPress={cancel}
                    disabled={phase === 'submitting'}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel"
                    testID="confirm-action-cancel"
                  >
                    <Text style={[styles.secondaryText, { color: c.ink2 }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primary, { backgroundColor: c.amber, opacity: canSubmit ? 1 : 0.5 }]}
                    onPress={() => void submit()}
                    disabled={!canSubmit}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm"
                    accessibilityState={{ disabled: !canSubmit, busy: phase === 'submitting' }}
                    testID="confirm-action-confirm"
                  >
                    {phase === 'submitting' ? (
                      <ActivityIndicator color={c.black} />
                    ) : (
                      <Text style={[styles.primaryText, { color: c.black }]}>Confirm</Text>
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          </BottomSheetScrollView>
        </BottomSheet>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24 },
  scrollBody: { paddingBottom: 16 },
  title: { fontSize: 20, fontWeight: '600', letterSpacing: -0.3, marginBottom: 6 },
  body: { fontSize: 14, lineHeight: 20, marginBottom: 16 },
  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    marginBottom: 16,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  secondary: { paddingVertical: 14, paddingHorizontal: 12 },
  secondaryText: { fontSize: 15, fontWeight: '500' },
  primary: { flex: 1, paddingVertical: 14, borderRadius: radii.md, alignItems: 'center' },
  primaryText: { fontSize: 16, fontWeight: '700' },
});
