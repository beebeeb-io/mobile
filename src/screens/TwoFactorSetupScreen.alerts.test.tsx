// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
// Task 1610, Issue 2 — Guus, 2026-09-30, verbatim: "when i disable 2fa i get
// a black screen on ios, need to restart the app to continue again. The
// popups are just regular popups and not the ones we often use in the app."
//
// Root cause (TwoFactorSetupScreen.tsx `handleDisabled`, pre-fix): a native
// `Alert.alert(...)` (async/animated UIAlertController presentation) was
// followed IMMEDIATELY by a synchronous `navigation.goBack()` — popping the
// screen's view controller while the alert was still presenting on top of
// it. That native race is not literally reproducible in this JS test
// environment (there's no real UIAlertController here), but its JS-visible
// fingerprint is exactly reproducible and exactly what caused it: a
// blocking `Alert.alert` call sharing a code path with an immediate
// navigation. This file (the "already ON" entry point, `totp_enabled:
// true`) proves that fingerprint is gone for Turn off and Set up again —
// `Alert.alert` never fires, and the disable-success path still leaves the
// screen with real, well-formed content plus a single, valid
// `navigation.goBack()` call. `TwoFactorSetupScreen.wizard-alerts.test.tsx`
// covers the remaining two call sites (fresh-enrollment wizard: copy secret,
// verify-code failure, copy backup codes) — split into its own file/process
// because it needs the OPPOSITE `totp_enabled` value and `bun run test`
// isolates `mock.module` per file, not per test (task 0877).
//
// Follows the module-mocking convention established in
// `src/components/FileIcon.test.tsx`, extended with `react-test-renderer`
// (added as a devDependency by this task) since these components use real
// `useState`/`useCallback`/`useRef` — `FileIcon`'s "call `.type(props)`
// directly" shortcut only works because ALL of its own hooks are mocked
// away; that shortcut does not apply here.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── react-native primitives — plain pass-through components (no native host,
// no real hooks of their own), matching FileIcon.test.tsx's convention.
// Each renders ONLY its children (a Fragment) rather than re-wrapping the
// same props onto a second host-tagged element — that would make every
// testID/accessibilityLabel lookup match twice (the composite call site
// AND the echoed host node) for no benefit; `findAll` below instead
// disambiguates by TYPE (TouchableOpacity vs TextInput vs a plain wrapper),
// so each interactive element resolves to exactly one match. ─────────────
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
mock.module('expo-clipboard', () => ({ setStringAsync: async () => {} }));

let navGoBackCalls: unknown[][] = [];
mock.module('@react-navigation/native', () => ({
  useNavigation: () => ({
    goBack: (...args: unknown[]) => { navGoBackCalls.push(args); },
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

let refreshAuthCalls = 0;
mock.module('../lib/auth', () => ({
  // On-state entry: this file only exercises an account with 2FA already
  // enabled (Turn off / Set up again). The wizard (2FA off) is covered by
  // the sibling file, in its own process — see the header comment.
  useAuth: () => ({
    user: { totp_enabled: true },
    refreshAuth: async () => { refreshAuthCalls += 1; },
  }),
}));

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let disableTotpImpl: (code: string) => Promise<void> = async () => {};
let setupTotpImpl: (opts?: { code?: string; confirmToken?: string }) => Promise<{ secret: string; qr_uri: string; backup_codes: string[] }> =
  async () => ({ secret: 'SECRET123', qr_uri: 'otpauth://totp/x', backup_codes: ['a', 'b'] });

mock.module('../lib/api', () => ({
  setupTotp: (opts?: { code?: string; confirmToken?: string }) => setupTotpImpl(opts),
  enableTotp: async () => {},
  disableTotp: (code: string) => disableTotpImpl(code),
  friendlyError: (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.'),
  ApiError,
}));

let requestConfirmationImpl: () => Promise<string | null> = async () => null;
mock.module('../lib/confirm-action', () => ({
  requestConfirmation: () => requestConfirmationImpl(),
}));

let toastCalls: Array<{ type: string; message: string }> = [];
mock.module('../lib/toast-context', () => ({
  useToast: () => ({
    showToast: (opts: { type: string; message: string }) => { toastCalls.push(opts); },
  }),
}));

const { default: TwoFactorSetupScreen } = await import('./TwoFactorSetupScreen');

// Disambiguate by TYPE: the composite call site (e.g. SecondaryButton) and
// the TouchableOpacity/TextInput it renders both carry the SAME testID/
// accessibilityLabel prop (it's forwarded verbatim), so an unqualified
// props match finds both. Only the TouchableOpacity/TextInput instance
// actually has `onPress`/`onChangeText` — that's the one tests need.
function findByAccessibilityLabel(root: TestRenderer.ReactTestInstance, label: string) {
  return root.findAll((node) => node.type === TouchableOpacity && node.props?.accessibilityLabel === label);
}

function findByTestID(root: TestRenderer.ReactTestInstance, testID: string) {
  return root.findAll(
    (node) => (node.type === TouchableOpacity || node.type === TextInput) && node.props?.testID === testID,
  );
}

beforeEach(() => {
  alertCalls.length = 0;
  navGoBackCalls = [];
  refreshAuthCalls = 0;
  toastCalls = [];
  disableTotpImpl = async () => {};
  setupTotpImpl = async () => ({ secret: 'SECRET123', qr_uri: 'otpauth://totp/x', backup_codes: ['a', 'b'] });
  requestConfirmationImpl = async () => null;
});

let renderer: TestRenderer.ReactTestRenderer | null = null;
afterEach(() => {
  if (renderer) {
    act(() => { renderer!.unmount(); });
    renderer = null;
  }
});

describe('TwoFactorSetupScreen — Turn off success (task 1610, Issue 2)', () => {
  test('no black screen: succeeds without Alert.alert, the tree still renders real content, and navigates back exactly once', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(TwoFactorSetupScreen));
    });
    const root = renderer!.root;

    // Enrolled account opens on the On state (task 1610 fix #1) — tap "Turn off".
    const turnOffRow = findByTestID(root, 'totp-turn-off');
    expect(turnOffRow.length).toBe(1);
    act(() => { turnOffRow[0].props.onPress(); });

    // Now on StepDisable — type a 6-digit code.
    const codeField = findByTestID(renderer!.root, 'totp-disable-code');
    expect(codeField.length).toBe(1);
    act(() => { codeField[0].props.onChangeText('123456'); });

    const submitButton = findByAccessibilityLabel(renderer!.root, 'Turn off 2FA');
    expect(submitButton.length).toBe(1);

    await act(async () => {
      submitButton[0].props.onPress();
      // Flush the async disableTotp()/onDone() chain.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The fingerprint of the black-screen bug: Alert.alert must never fire
    // on this path (that's the modal that raced the navigation pop).
    expect(alertCalls.length).toBe(0);

    // The in-app toast fires instead — non-modal, cannot race navigation.
    expect(toastCalls).toEqual([{ type: 'success', message: 'Two-factor authentication turned off.' }]);

    // refreshAuth() ran so Settings reflects "Off" without a restart.
    expect(refreshAuthCalls).toBe(1);

    // navigation.goBack() ran exactly once — a plain pop (no arguments, no
    // named/broken route), and only once (never double-popped).
    expect(navGoBackCalls.length).toBe(1);
    expect(navGoBackCalls[0]).toEqual([]);

    // "No black screen": the renderer's tree is still real, well-formed
    // content after the whole success sequence — not null, not empty. (The
    // screen itself doesn't unmount here since `navigation.goBack()` is
    // mocked — what this proves is that reaching this point never throws
    // and never collapses the tree to nothing.)
    const json = renderer!.toJSON();
    expect(json).not.toBeNull();
  });

  test('wrong code on Turn off: no Alert.alert, inline error only, no navigation', async () => {
    disableTotpImpl = async () => {
      throw new ApiError(400, 'wrong_code_on_authenticated_route');
    };
    act(() => {
      renderer = TestRenderer.create(React.createElement(TwoFactorSetupScreen));
    });
    act(() => { findByTestID(renderer!.root, 'totp-turn-off')[0].props.onPress(); });
    act(() => { findByTestID(renderer!.root, 'totp-disable-code')[0].props.onChangeText('000000'); });

    await act(async () => {
      findByAccessibilityLabel(renderer!.root, 'Turn off 2FA')[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alertCalls.length).toBe(0);
    expect(navGoBackCalls.length).toBe(0);
    const errorText = renderer!.root.findAll(
      (n) => n.type === Text && (n.props as { children?: unknown }).children === 'Incorrect code. Try again.',
    );
    expect(errorText.length).toBe(1);
  });
});

describe('TwoFactorSetupScreen — Set up again / password step-up (task 1610, Issue 2)', () => {
  test('password step-up failure toasts an error, never alerts', async () => {
    requestConfirmationImpl = async () => 'confirm-token-abc';
    setupTotpImpl = async () => { throw new Error('server exploded'); };

    act(() => {
      renderer = TestRenderer.create(React.createElement(TwoFactorSetupScreen));
    });
    act(() => { findByTestID(renderer!.root, 'totp-set-up-again')[0].props.onPress(); });

    const passwordLink = findByAccessibilityLabel(renderer!.root, 'Use your password instead');
    expect(passwordLink.length).toBe(1);
    await act(async () => {
      passwordLink[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(alertCalls.length).toBe(0);
    expect(toastCalls).toEqual([{ type: 'error', message: 'Could not start setup: server exploded' }]);
  });
});
