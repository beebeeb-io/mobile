/**
 * Native signup route (task 1746). Fetches the pre-account onboarding document and
 * hands it to the flow. The document decides EVERYTHING: whether signup is open
 * here, the steps, the numbers. A document we cannot use falls back to the old
 * text-only "create your account on the web" line (spec 5.8 rule 6).
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { spacing } from '../theme';
import { OnboardingFrame, PrimaryButton, Spinner, useOnboardingStyles } from '../components/onboarding/ui';
import { SignupFlow, renderTerminalScreen } from '../components/onboarding/SignupFlow';
import { SignupUnavailable, UnsupportedSchema } from '../components/onboarding/BlockingScreens';
import { createSignupPorts } from '../lib/onboarding/default-ports';
import { ACCOUNT_EXISTS_MESSAGE } from '../lib/onboarding/copy';
import { unsupportedSchemaScreen } from '../lib/onboarding/plan';
import { usePreAccountDocument } from '../lib/onboarding/use-pre-account';
import { useAuth } from '../lib/auth';
import { useCrypto } from '../lib/crypto-context';
import { markUnlocked } from '../lib/lock-state';
import { endSignupUnlock } from '../lib/signup-unlock-guard';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export default function SignupScreen() {
  const navigation = useNavigation<Nav>();
  const { refreshAuth } = useAuth();
  const crypto = useCrypto();
  const { s } = useOnboardingStyles();
  const { state, reload } = usePreAccountDocument();
  const [existingEmail, setExistingEmail] = useState<string | null>(null);

  // The ports must stay referentially stable (the flow's ceremony effect depends
  // on `ports.ceremony`), while `unlock` changes identity with provider state.
  const cryptoRef = useRef(crypto);
  cryptoRef.current = crypto;
  const adoptVault = useCallback(async (masterKey: Uint8Array): Promise<boolean> => {
    try {
      // The signed-out provider stores the key UNBOUND; the user-keyed provider that
      // mounts after refreshAuth() proves it against the server's recovery binding.
      await cryptoRef.current.unlock(undefined, 'new_account', masterKey);
      return true;
    } catch {
      return false;
    } finally {
      masterKey.fill(0);
    }
  }, []);
  const ports = useMemo(() => createSignupPorts(adoptVault), [adoptVault]);

  const goToLogin = useCallback(
    (email?: string) => {
      navigation.navigate('Login', email ? { email } : undefined);
    },
    [navigation],
  );

  const handleCreated = useCallback(async () => {
    try {
      markUnlocked();
      // The session token is already stored (register-finish). Refreshing auth flips
      // the navigator to the signed-in stack; the user-keyed CryptoProvider then
      // unlocks from the keychain. If the vault did not adopt the key here, the
      // app's "Vault locked" screen asks for the recovery phrase just written down.
      await refreshAuth();
    } finally {
      endSignupUnlock();
    }
  }, [refreshAuth]);

  if (existingEmail !== null) {
    return (
      <OnboardingFrame title="This address already has an account" testID="signup-account-exists">
        <Text style={s.body}>{ACCOUNT_EXISTS_MESSAGE}</Text>
        <PrimaryButton label="Sign in" onPress={() => goToLogin(existingEmail)} testID="signup-account-exists-sign-in" style={{ marginTop: spacing.xl }} />
      </OnboardingFrame>
    );
  }

  switch (state.status) {
    case 'loading':
      return (
        <OnboardingFrame title="Create your account" testID="signup-loading">
          <Spinner label="Loading" />
        </OnboardingFrame>
      );
    case 'unsupported_schema':
      return <UnsupportedSchema screen={unsupportedSchemaScreen()} />;
    case 'legacy':
      if (state.reason === 'network') {
        return (
          <OnboardingFrame
            title="Could not reach the server"
            subtitle="Check your connection and try again."
            onBack={() => goToLogin()}
            backLabel="Sign in"
            testID="signup-offline"
          >
            <PrimaryButton label="Try again" onPress={reload} testID="signup-retry" />
          </OnboardingFrame>
        );
      }
      return (
        <SignupUnavailable
          screen={{ kind: 'signup_unavailable', mode: 'web_only', reason: null, webUrl: null }}
          onBack={() => goToLogin()}
        />
      );
    case 'document':
      return (
        <SignupFlow
          doc={state.doc}
          ports={ports}
          onCreated={() => void handleCreated()}
          onAccountExists={(email) => setExistingEmail(email)}
          onCancel={() => goToLogin()}
          onRefresh={reload}
        />
      );
    default:
      return renderTerminalScreen({ kind: 'created' }, { onRefresh: reload });
  }
}
