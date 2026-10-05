/**
 * The account-stage onboarding overlay (task 1746, spec 5.9): covers the file UI
 * ONLY while the document says the app must show onboarding first (`blocking`) and
 * this build has something to show: a step it can do (`verify_email`,
 * `accept_terms`), a client that is too old (`update_required`, rule 7), a schema it
 * does not understand (rule 5), or a required step it cannot do (rule 3). Anything
 * else renders nothing: the vault is usable and the status text lives in Storage and
 * Files.
 *
 * Sits beside `NeedsPlanOverlay` (the full-screen text for an account without an
 * allowance); rendered after it so it wins when both apply. `accessibilityViewIsModal`
 * keeps VoiceOver off the UI behind it. No zIndex on purpose: render order keeps the
 * biometric lock (rendered after it in App.tsx) on top.
 */
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useAccountState } from '../../lib/account-state-context';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme-context';
import { overlayScreen } from '../../lib/onboarding/overlay-screen';
import { StepBlocked, StepFallback, UnsupportedSchema, UpdateRequired } from './BlockingScreens';
import { AcceptTermsAccountStep, VerifyEmailAccountStep } from './AccountSteps';

export function AccountOnboardingOverlay() {
  const { document, unsupportedSchema, refresh } = useAccountState();
  const { signOut } = useAuth();
  const { colors: c } = useTheme();
  const screen = useMemo(() => overlayScreen(document, unsupportedSchema), [document, unsupportedSchema]);
  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);
  const onDone = useCallback(async () => {
    await refresh();
  }, [refresh]);

  if (!screen) return null;

  let body: React.ReactNode = null;
  switch (screen.kind) {
    case 'update_required':
      body = <UpdateRequired screen={screen} onSignOut={signOut} />;
      break;
    case 'unsupported_schema':
      body = <UnsupportedSchema screen={screen} />;
      break;
    case 'fallback':
      body = <StepFallback screen={screen} onSignOut={signOut} />;
      break;
    case 'blocked':
      body = <StepBlocked screen={screen} onRefresh={onRefresh} onSignOut={signOut} />;
      break;
    case 'step':
      if (screen.stepId === 'verify_email') {
        body = <VerifyEmailAccountStep screen={screen} onDone={onDone} onSignOut={signOut} />;
      } else if (screen.stepId === 'accept_terms' && document) {
        body = <AcceptTermsAccountStep screen={screen} doc={document} onDone={onDone} onSignOut={signOut} />;
      }
      break;
  }
  if (!body) return null;

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.paper }]} accessibilityViewIsModal testID="account-onboarding-overlay">
      {body}
    </View>
  );
}
