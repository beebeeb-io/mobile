/**
 * Shared building blocks for the native signup and the account-stage steps
 * (task 1746). Styled like their siblings (`LoginScreen`, `NeedsPlanScreen`):
 * plain surface, brand mark, ONE amber primary per screen, JetBrains Mono for
 * machine text (codes, counters, the phrase). No `design/ios26-canvas/` artboard
 * covers account setup (DEVIATIONS.md, task 1746).
 */
import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BBLogo } from '../BBLogo';
import { BBWordmark } from '../BBWordmark';
import { fonts, onAmber, radii, spacing } from '../../theme';
import { useTheme } from '../../lib/theme-context';

export function useOnboardingStyles() {
  const { colors: c, resolved } = useTheme();
  return useMemo(
    () => ({
      c,
      resolved,
      s: StyleSheet.create({
        root: { flex: 1, backgroundColor: c.paper },
        content: { flexGrow: 1, paddingHorizontal: spacing.xl },
        topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
        brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        progress: { fontSize: 12, color: c.ink4, fontFamily: fonts.mono },
        back: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, paddingRight: spacing.md },
        backText: { fontSize: 15, color: c.amberDeep, marginLeft: 2 },
        title: { fontSize: 24, fontWeight: '700', color: c.ink, marginTop: spacing.lg, marginBottom: 6 },
        subtitle: { fontSize: 14, color: c.ink3, lineHeight: 20, marginBottom: spacing.xl },
        label: { fontSize: 12, fontWeight: '600', color: c.ink2, marginBottom: 4, marginTop: spacing.md },
        input: {
          height: 46,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: radii.md,
          paddingHorizontal: spacing.md,
          fontSize: 15,
          color: c.ink,
          backgroundColor: c.paper,
        },
        inputError: { borderColor: c.red },
        error: {
          backgroundColor: resolved === 'dark' ? '#2d1515' : '#fef2f2',
          borderWidth: 1,
          borderColor: resolved === 'dark' ? '#5c2828' : '#fecaca',
          borderRadius: radii.md,
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          marginTop: spacing.md,
        },
        errorText: { fontSize: 13, color: c.red, lineHeight: 18 },
        notice: {
          backgroundColor: c.paper2,
          borderWidth: 1,
          borderColor: c.line,
          borderRadius: radii.md,
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          marginBottom: spacing.md,
        },
        noticeText: { fontSize: 13, color: c.ink2, lineHeight: 18 },
        button: {
          minHeight: 48,
          borderRadius: radii.md,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
        },
        primary: { backgroundColor: c.amber },
        secondary: { backgroundColor: c.paper, borderWidth: 1, borderColor: c.line },
        disabled: { opacity: 0.45 },
        primaryText: { color: onAmber, fontSize: 15, fontWeight: '800', textAlign: 'center' },
        secondaryText: { color: c.ink2, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        linkText: { color: c.amberDeep, fontSize: 13, fontWeight: '600' },
        mutedText: { color: c.ink3, fontSize: 13 },
        body: { fontSize: 15, color: c.ink2, lineHeight: 22 },
        region: { alignItems: 'center', marginTop: spacing['2xl'] },
        regionText: { fontSize: 11, color: c.ink4 },
        checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: spacing.sm },
        checkBox: {
          width: 24,
          height: 24,
          borderRadius: radii.sm,
          borderWidth: 1.5,
          borderColor: c.line2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: c.paper,
          marginTop: 1,
        },
        checkBoxOn: { backgroundColor: c.amber, borderColor: c.amber },
        checkText: { flex: 1, fontSize: 14, color: c.ink2, lineHeight: 20 },
      }),
    }),
    [c, resolved],
  );
}

export function OnboardingFrame({
  title,
  subtitle,
  position,
  total,
  onBack,
  backLabel = 'Back',
  regionLine,
  children,
  testID,
  noBrand,
}: {
  title: string;
  subtitle?: string;
  position?: number;
  total?: number;
  onBack?: () => void;
  backLabel?: string;
  /** `copy.region_line` from the document, rendered verbatim. */
  regionLine?: string | null;
  children?: React.ReactNode;
  testID?: string;
  noBrand?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { s, c } = useOnboardingStyles();
  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} testID={testID}>
      <ScrollView
        contentContainerStyle={[s.content, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        <View style={s.topRow}>
          {onBack ? (
            <TouchableOpacity
              style={s.back}
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel={backLabel}
              testID="onboarding-back"
            >
              <Ionicons name="chevron-back" size={20} color={c.amberDeep} />
              <Text style={s.backText}>{backLabel}</Text>
            </TouchableOpacity>
          ) : noBrand ? (
            <View />
          ) : (
            <View style={s.brand}>
              <BBLogo size={28} />
              <BBWordmark size={16} />
            </View>
          )}
          {position != null && total != null && total > 1 ? (
            <Text style={s.progress} accessibilityLabel={`Step ${position} of ${total}`} testID="onboarding-progress">
              {position} / {total}
            </Text>
          ) : null}
        </View>
        <Text style={s.title} accessibilityRole="header">{title}</Text>
        {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : <View style={{ height: spacing.md }} />}
        {children}
        {regionLine ? (
          <View style={s.region}>
            <Text style={s.regionText}>{regionLine}</Text>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Field({
  label,
  invalid,
  inputRef,
  mono,
  ...input
}: TextInputProps & { label: string; invalid?: boolean; mono?: boolean; inputRef?: React.Ref<TextInput> }) {
  const { s, c } = useOnboardingStyles();
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        ref={inputRef}
        placeholderTextColor={c.ink4}
        accessibilityLabel={input.accessibilityLabel ?? label}
        {...input}
        style={[s.input, mono && { fontFamily: fonts.mono }, invalid && s.inputError, input.style]}
      />
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { s } = useOnboardingStyles();
  const off = disabled || busy;
  return (
    <TouchableOpacity
      style={[s.button, s.primary, off && s.disabled, style]}
      onPress={onPress}
      disabled={off}
      activeOpacity={0.82}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={onAmber} /> : <Text style={s.primaryText}>{label}</Text>}
    </TouchableOpacity>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { s } = useOnboardingStyles();
  return (
    <TouchableOpacity
      style={[s.button, s.secondary, disabled && s.disabled, style]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.78}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
    >
      <Text style={s.secondaryText}>{label}</Text>
    </TouchableOpacity>
  );
}

export function ErrorLine({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const { s } = useOnboardingStyles();
  return (
    <View style={s.error} accessibilityLiveRegion="polite" accessibilityRole="alert" testID={testID ?? 'onboarding-error'}>
      <Text style={s.errorText}>{children}</Text>
    </View>
  );
}

export function Notice({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const { s } = useOnboardingStyles();
  return (
    <View style={s.notice} accessibilityLiveRegion="polite" testID={testID}>
      <Text style={s.noticeText}>{children}</Text>
    </View>
  );
}

export function CheckRow({
  checked,
  onChange,
  children,
  testID,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
  testID?: string;
}) {
  const { s } = useOnboardingStyles();
  return (
    <TouchableOpacity
      style={s.checkRow}
      onPress={() => onChange(!checked)}
      activeOpacity={0.7}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      testID={testID}
    >
      <View style={[s.checkBox, checked && s.checkBoxOn]}>
        {checked ? <Ionicons name="checkmark" size={16} color={onAmber} /> : null}
      </View>
      <Text style={s.checkText}>{children}</Text>
    </TouchableOpacity>
  );
}

export function Spinner({ label }: { label: string }) {
  const { s, c } = useOnboardingStyles();
  return (
    <View style={{ alignItems: 'center', paddingVertical: spacing.xl }} accessibilityLiveRegion="polite">
      <ActivityIndicator color={c.amber} />
      <Text style={[s.mutedText, { marginTop: spacing.md }]}>{label}</Text>
    </View>
  );
}
