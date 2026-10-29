// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
// Task 1610, Issue 2 — sibling file to `TwoFactorSetupScreen.alerts.test.tsx`
// (see its header comment for the full root-cause account). This file covers
// the fresh-enrollment wizard's Alert.alert call sites (copy secret, a
// verify-code failure, copy backup codes) — it needs `totp_enabled: false`
// so the screen opens straight into the wizard, the opposite of the sibling
// file's on-state entry, hence its own file/process (`bun run test`
// isolates `mock.module` per FILE, not per test — task 0877).
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// See TwoFactorSetupScreen.alerts.test.tsx's header comment for why these
// render only a Fragment of `children` (never re-wrap the same props onto a
// second host-tagged element) and why lookups below disambiguate by TYPE.
const View = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const Text = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const TextInput = (_props: Record<string, unknown>) => null;
const TouchableOpacity = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const ScrollView = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const ActivityIndicator = (_props: Record<string, unknown>) => null;

const alertCalls: unknown[][] = [];
const Alert = { alert: (...args: unknown[]) => { alertCalls.push(args); } };

mock.module('react-native', () => ({
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
  StyleSheet: { create: (s: unknown) => s },
  Alert,
  Platform: { OS: 'ios' },
}));

mock.module('@expo/vector-icons', () => ({
  Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));
mock.module('expo-haptics', () => ({
  selectionAsync: async () => {},
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Medium: 'medium' },
}));
mock.module('expo-screen-capture', () => ({ usePreventScreenCapture: () => {} }));

let clipboardWrites: string[] = [];
mock.module('expo-clipboard', () => ({
  setStringAsync: async (s: string) => { clipboardWrites.push(s); },
}));

mock.module('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: () => {},
    setOptions: () => {},
    addListener: () => () => {},
  }),
}));

mock.module('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

mock.module('../lib/theme-context', () => ({
  useTheme: () => ({
    colors: {
      amber: '#f6c03a', ink: '#111', ink3: '#555', ink4: '#888',
      line: '#ddd', line2: '#ccc', paper: '#fff', paper2: '#eee',
      red: '#c33', green: '#393', black: '#000',
    },
  }),
}));

mock.module('../lib/auth', () => ({
  // Wizard entry: an account with 2FA OFF — the screen must open straight
  // into the fresh-enrollment wizard (unchanged pre-1610 behavior for this
  // case), never the On state.
  useAuth: () => ({ user: { totp_enabled: false }, refreshAuth: async () => {} }),
}));

let enableTotpImpl: (code: string) => Promise<void> = async () => {};

mock.module('../lib/api', () => ({
  setupTotp: async () => ({ secret: 'SECRET123', qr_uri: 'otpauth://totp/x', backup_codes: ['aaaa-1111', 'bbbb-2222'] }),
  enableTotp: (code: string) => enableTotpImpl(code),
  disableTotp: async () => {},
  friendlyError: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

mock.module('../lib/confirm-action', () => ({ requestConfirmation: async () => null }));

let toastCalls: Array<{ type: string; message: string }> = [];
mock.module('../lib/toast-context', () => ({
  useToast: () => ({
    showToast: (opts: { type: string; message: string }) => { toastCalls.push(opts); },
  }),
}));

const { default: TwoFactorSetupScreen } = await import('./TwoFactorSetupScreen');

function findByAccessibilityLabel(root: TestRenderer.ReactTestInstance, label: string) {
  return root.findAll((node) => node.type === TouchableOpacity && node.props?.accessibilityLabel === label);
}

beforeEach(() => {
  alertCalls.length = 0;
  toastCalls = [];
  clipboardWrites = [];
  enableTotpImpl = async () => {};
});

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer) {
    act(() => { renderer!.unmount(); });
    renderer = null;
  }
});

describe('TwoFactorSetupScreen — fresh-enrollment wizard never uses Alert.alert (task 1610)', () => {
  test('copying the setup secret (step 1) toasts, never alerts', async () => {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TwoFactorSetupScreen));
      await Promise.resolve();
      await Promise.resolve();
    });

    const copyButton = findByAccessibilityLabel(renderer!.root, 'Copy secret');
    expect(copyButton.length).toBe(1);
    await act(async () => {
      copyButton[0].props.onPress();
      await Promise.resolve();
    });

    expect(alertCalls.length).toBe(0);
    expect(toastCalls).toEqual([{ type: 'success', message: 'Secret key copied to clipboard.' }]);
    expect(clipboardWrites[0]).toBe('SECRET123');
  });

  test('verify-code failure (step 2) toasts an error, never alerts', async () => {
    enableTotpImpl = async () => { throw new Error('network down'); };

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TwoFactorSetupScreen));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => { findByAccessibilityLabel(renderer!.root, 'Continue')[0].props.onPress(); });

    const digitInputs = renderer!.root
      .findAllByType(TextInput)
      .filter((n) => (n.props.accessibilityLabel as string | undefined)?.startsWith('Digit '));
    expect(digitInputs.length).toBe(6);
    // The first digit box's onChangeText handles a full 6-digit paste.
    act(() => { digitInputs[0].props.onChangeText('123456'); });

    await act(async () => {
      findByAccessibilityLabel(renderer!.root, 'Enable 2FA')[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alertCalls.length).toBe(0);
    expect(toastCalls).toEqual([{ type: 'error', message: 'Verification failed: network down' }]);
  });

  test('copying all backup codes (step 3, after a successful enroll) toasts, never alerts', async () => {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(TwoFactorSetupScreen));
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => { findByAccessibilityLabel(renderer!.root, 'Continue')[0].props.onPress(); });
    const digitInputs = renderer!.root
      .findAllByType(TextInput)
      .filter((n) => (n.props.accessibilityLabel as string | undefined)?.startsWith('Digit '));
    act(() => { digitInputs[0].props.onChangeText('123456'); });

    await act(async () => {
      findByAccessibilityLabel(renderer!.root, 'Enable 2FA')[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    const copyAllButton = findByAccessibilityLabel(renderer!.root, 'Copy all codes');
    expect(copyAllButton.length).toBe(1);
    await act(async () => {
      copyAllButton[0].props.onPress();
      await Promise.resolve();
    });

    expect(alertCalls.length).toBe(0);
    expect(toastCalls.at(-1)).toEqual({ type: 'success', message: 'All backup codes copied to clipboard.' });
    expect(clipboardWrites.at(-1)).toBe('aaaa-1111\nbbbb-2222');
  });
});
