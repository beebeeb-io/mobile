/**
 * The terminal screens the planner can return (task 1746, spec 5.8): a version
 * that is too old, a schema we do not understand, signup that is not open here,
 * a required step this build cannot do, a required step that is blocked.
 *
 * Text first. A way out is offered only as `fallbackAction` allows it: the App
 * Store page for an update, a mail to support, and NEVER a web link while
 * `WEB_ACCOUNT_LINKS_ENABLED` is off (App Review 3.1.1(a), task 1400).
 */
import React, { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { WEB_ACCOUNT_LINKS_ENABLED } from '../../lib/web-links';
import { fallbackAction } from '../../lib/onboarding/fallback-action';
import type {
  BlockedScreen,
  FallbackScreen,
  SignupUnavailableScreen,
  UnsupportedSchemaScreen,
  UpdateRequiredScreen,
} from '../../lib/onboarding/plan';
import type { Fallback } from '../../lib/onboarding/types';
import { spacing } from '../../theme';
import { OnboardingFrame, PrimaryButton, SecondaryButton, useOnboardingStyles } from './ui';

function FallbackBlock({ fallback, testID }: { fallback: Fallback | null; testID: string }) {
  const { s } = useOnboardingStyles();
  const action = fallbackAction(fallback, WEB_ACCOUNT_LINKS_ENABLED);
  if (action.kind === 'text') {
    return (
      <Text style={s.body} testID={testID}>
        {action.text}
      </Text>
    );
  }
  return (
    <PrimaryButton
      label={action.label}
      onPress={() => {
        Linking.openURL(action.url).catch(() => {});
      }}
      testID={testID}
    />
  );
}

export function UpdateRequired({
  screen,
  onSignOut,
}: {
  screen: UpdateRequiredScreen;
  /** Supplied only where a session can exist: the contract lets this screen block everything EXCEPT Sign out. */
  onSignOut?: () => Promise<void>;
}) {
  const [signingOut, setSigningOut] = useState(false);
  return (
    <OnboardingFrame
      title="This version is too old"
      subtitle={
        screen.minVersion
          ? `Beebeeb ${screen.minVersion} or newer is needed to continue. Nothing else works until you update.`
          : 'A newer version is needed to continue. Nothing else works until you update.'
      }
      testID="update-required-screen"
    >
      <FallbackBlock fallback={screen.fallback} testID="update-required-action" />
      {onSignOut ? (
        <View style={{ marginTop: spacing.md }}>
          <SecondaryButton
            label="Sign out"
            disabled={signingOut}
            testID="update-required-sign-out"
            onPress={() => {
              setSigningOut(true);
              onSignOut().finally(() => setSigningOut(false));
            }}
          />
        </View>
      ) : null}
    </OnboardingFrame>
  );
}

export function UnsupportedSchema({ screen }: { screen: UnsupportedSchemaScreen }) {
  return (
    <OnboardingFrame
      title="Update to continue"
      subtitle="The server is speaking a newer version of sign-up than this version of the app understands. We will not guess."
      testID="unsupported-schema-screen"
    >
      <FallbackBlock fallback={{ kind: 'update_app', url: screen.fallback.url }} testID="unsupported-schema-action" />
    </OnboardingFrame>
  );
}

export function SignupUnavailable({ screen, onBack }: { screen: SignupUnavailableScreen; onBack?: () => void }) {
  const { s } = useOnboardingStyles();
  return (
    <OnboardingFrame
      title="Sign-up is not open in the app"
      subtitle="Create your account on the web at beebeeb.io, then sign in here."
      onBack={onBack}
      backLabel="Sign in"
      testID="signup-unavailable-screen"
    >
      {WEB_ACCOUNT_LINKS_ENABLED && screen.webUrl ? (
        <FallbackBlock fallback={{ kind: 'use_web', url: screen.webUrl }} testID="signup-unavailable-action" />
      ) : (
        <Text style={s.mutedText}>Your files stay encrypted on your devices either way.</Text>
      )}
    </OnboardingFrame>
  );
}

export function StepFallback({ screen, onSignOut }: { screen: FallbackScreen; onSignOut?: () => Promise<void> }) {
  const { s } = useOnboardingStyles();
  return (
    <OnboardingFrame
      title="We cannot do this step here yet"
      subtitle="This step is newer than this version of the app. Update the app, or finish it where it is supported."
      testID="step-fallback-screen"
    >
      <Text style={[s.mutedText, { marginBottom: spacing.md }]}>
        Step <Text testID="fallback-step-id">{screen.stepId}</Text>
      </Text>
      <FallbackBlock fallback={screen.fallback} testID="step-fallback-action" />
      {onSignOut ? (
        <View style={{ marginTop: spacing.md }}>
          <SecondaryButton label="Sign out" testID="step-fallback-sign-out" onPress={() => { void onSignOut(); }} />
        </View>
      ) : null}
    </OnboardingFrame>
  );
}

export function StepBlocked({
  screen,
  onRefresh,
  onSignOut,
}: {
  screen: BlockedScreen;
  onRefresh: () => void;
  onSignOut?: () => Promise<void>;
}) {
  const { s } = useOnboardingStyles();
  return (
    <OnboardingFrame
      title="This step is not available right now"
      subtitle="We could not start it. Nothing was lost; try again in a moment."
      testID="step-blocked-screen"
    >
      <Text style={[s.mutedText, { marginBottom: spacing.md }]}>
        Step <Text testID="blocked-step-id">{screen.stepId}</Text>
      </Text>
      {screen.fallback ? <FallbackBlock fallback={screen.fallback} testID="step-blocked-action" /> : null}
      <View style={{ marginTop: spacing.md, gap: spacing.md }}>
        <SecondaryButton label="Check again" onPress={onRefresh} testID="step-blocked-refresh" />
        {onSignOut ? <SecondaryButton label="Sign out" testID="step-blocked-sign-out" onPress={() => { void onSignOut(); }} /> : null}
      </View>
    </OnboardingFrame>
  );
}
