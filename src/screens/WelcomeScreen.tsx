/**
 * First-run screen (task 1746; the "how it works" part of 1703). Shown ONCE to a
 * fresh install, before Login: three plain statements about what Beebeeb is, then
 * Create account (only when the server says this build may sign up natively) and
 * Sign in. No marketing, no emojis, honest voice ("We can't recover this").
 *
 * Out of scope here, still 1703's: the Face ID opt-in (it needs the 1684 vault
 * state model and its own decision), and a design-lane pass on the visuals.
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { spacing } from '../theme';
import { OnboardingFrame, PrimaryButton, SecondaryButton, useOnboardingStyles } from '../components/onboarding/ui';
import { canSignUpNatively } from '../lib/onboarding/pre-account';
import { usePreAccountDocument } from '../lib/onboarding/use-pre-account';
import { createAccountCopy, WEB_ACCOUNT_LINKS_ENABLED } from '../lib/web-links';
import { markWelcomeSeen } from '../lib/welcome-seen';
import type { RootStackParamList } from '../App';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const POINTS: Array<{ icon: React.ComponentProps<typeof Ionicons>['name']; title: string; body: string }> = [
  {
    icon: 'lock-closed-outline',
    title: 'Encrypted on your device',
    body: 'Your files are encrypted on this phone before they leave it. We store the result and cannot read it.',
  },
  {
    icon: 'cube-outline',
    title: 'One vault, only you can open',
    body: 'Everything you keep lives in your vault. The key to it stays on your devices.',
  },
  {
    icon: 'key-outline',
    title: 'Your recovery phrase',
    body: 'Twelve words are the only way back in if you forget your password. We can\'t recover this for you.',
  },
];

export default function WelcomeScreen() {
  const navigation = useNavigation<Nav>();
  const { s, c } = useOnboardingStyles();
  const { state } = usePreAccountDocument();
  const native = canSignUpNatively(state);
  const loading = state.status === 'loading';
  const note = createAccountCopy(WEB_ACCOUNT_LINKS_ENABLED).text;

  // Seeing it once is enough, however the person leaves it.
  useEffect(() => {
    void markWelcomeSeen();
  }, []);

  return (
    <OnboardingFrame
      title="Private storage, in Europe"
      subtitle="Beebeeb keeps your files encrypted end to end. Here is what that means for you."
      regionLine="Stored in Europe."
      testID="welcome-screen"
    >
      <View style={{ gap: spacing.lg, marginBottom: spacing['2xl'] }}>
        {POINTS.map((p) => (
          <View key={p.title} style={{ flexDirection: 'row', gap: spacing.md }} testID={`welcome-point-${p.icon}`}>
            <Ionicons name={p.icon} size={22} color={c.amberDeep} style={{ marginTop: 2 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: c.ink }}>{p.title}</Text>
              <Text style={[s.body, { fontSize: 14, lineHeight: 20, marginTop: 2 }]}>{p.body}</Text>
            </View>
          </View>
        ))}
      </View>

      {native ? (
        <PrimaryButton label="Create account" onPress={() => navigation.navigate('Signup')} testID="welcome-create-account" />
      ) : loading ? (
        <View style={{ height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={c.amber} />
        </View>
      ) : null}
      <View style={{ marginTop: native || loading ? spacing.md : 0 }}>
        {native || loading ? (
          <SecondaryButton label="Sign in" onPress={() => navigation.navigate('Login', undefined)} testID="welcome-sign-in" />
        ) : (
          <PrimaryButton label="Sign in" onPress={() => navigation.navigate('Login', undefined)} testID="welcome-sign-in" />
        )}
      </View>
      {!native && !loading ? (
        <Text style={[s.mutedText, { textAlign: 'center', marginTop: spacing.lg, lineHeight: 18 }]} testID="welcome-create-account-note">
          {note}
        </Text>
      ) : null}
    </OnboardingFrame>
  );
}
