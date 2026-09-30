// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
// (matches every other *.test.ts(x) file in this repo).
//
// Task 1610, Issue 2 round 2 — `ConfirmActionPrompt`, the app's own
// password-prompt sheet, replacing iOS's native `Alert.prompt` (the other
// half of the Issue 2 report: "The popups are just regular popups and not
// the ones we often use in the app"). `confirm-action.test.ts` covers the
// business-logic module (`attempt()`'s outcome mapping, fail-closed with no
// prompter); this file drives the COMPONENT the way that module drives it —
// via a captured `registerConfirmPrompter` call — and proves:
//
//   1. wrong password re-prompts IN PLACE (same sheet instance, message
//      swapped, password cleared) — never a close/reopen cycle, and the
//      caller's promise stays unresolved throughout;
//   2. a fatal outcome (session-too-old / any other error) renders inline
//      in the sheet (title + message, password field hidden, a single OK)
//      — never a native Alert;
//   3. the caller's promise resolves ONLY after `BottomSheet`'s
//      `onDismissed` fires — never at the moment Confirm/Cancel/OK is
//      pressed, which is the same race-safety property that fixed Issue
//      2's black screen (Alert presenting/dismissing raced a synchronous
//      navigation.goBack()) — proven here for success, fatal-dismiss, and
//      cancel.
//
// `BottomSheet` itself (Animated + react-native-gesture-handler internals)
// is replaced with a trivial fake that always renders its children and
// hands the test direct control of `visible`/`onDismissed` — the same
// "mock every dependency, drive the real component with react-test-
// renderer" convention as TwoFactorSetupScreen.alerts.test.tsx, just one
// dependency further out. `BottomSheet.tsx`'s own geometry/detent math is
// covered by BottomSheet.test.ts + sheet-detents.test.ts; this file only
// needs it to exist as a slot for `visible`/`onDismissed`.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// ── react-native primitives — plain pass-through components, matching
// TwoFactorSetupScreen.alerts.test.tsx's convention. No `Alert` export at
// all: if the component ever called `Alert.alert(...)`/`Alert.prompt(...)`
// again, the destructured import would be `undefined` and the call would
// throw inside `act()`, failing loudly (belt; the source-text guard below
// is the permanent, RED-provable lock). ──────────────────────────────────
const View = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const Text = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const TextInput = (props: Record<string, unknown>) => React.createElement('TextInput', props);
const TouchableOpacity = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
const ActivityIndicator = (_props: Record<string, unknown>) => null;
const Modal = (props: Record<string, unknown>) => React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);

mock.module('react-native', () => ({
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, Modal,
  StyleSheet: { create: (s: unknown) => s },
}));

mock.module('react-native-gesture-handler', () => ({
  GestureHandlerRootView: (props: Record<string, unknown>) =>
    React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode),
}));

mock.module('../lib/theme-context', () => ({
  useTheme: () => ({
    colors: {
      amber: '#f6c03a', ink: '#111', ink2: '#333', ink3: '#555', ink4: '#888',
      line: '#ddd', line2: '#ccc', paper: '#fff', paper2: '#eee',
      red: '#c33', green: '#393', black: '#000', white: '#fff',
    },
  }),
}));

// ── The fake BottomSheet: always renders its children (a real one keeps its
// content mounted through the close animation too — `onDismissed` is what
// signals "actually gone"), and exposes its props to the test via
// `lastSheetProps` so it can flip `visible`/fire `onDismissed` by hand. ────
let lastSheetProps: Record<string, unknown> | null = null;
function FakeBottomSheet(props: Record<string, unknown>) {
  lastSheetProps = props;
  return React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
}
function FakeBottomSheetScrollView(props: Record<string, unknown>) {
  return React.createElement(React.Fragment, null, (props as { children?: unknown }).children as React.ReactNode);
}
mock.module('./sheet/BottomSheet', () => ({
  BottomSheet: FakeBottomSheet,
  BottomSheetScrollView: FakeBottomSheetScrollView,
}));

// ── confirm-action.ts is mocked here too (its own behaviour is
// confirm-action.test.ts's job) — only `registerConfirmPrompter` is
// needed, captured so the test can drive the sheet exactly like that
// module would: call it with a `{ title, message, attempt }` request. ────
let capturedPrompter: ((req: {
  title: string;
  message: string;
  attempt: (password: string) => Promise<unknown>;
}) => Promise<string | null>) | null = null;
let registerCalls: unknown[] = [];
mock.module('../lib/confirm-action', () => ({
  registerConfirmPrompter: (fn: typeof capturedPrompter) => {
    registerCalls.push(fn);
    capturedPrompter = fn;
  },
}));

const { default: ConfirmActionPrompt } = await import('./ConfirmActionPrompt');

function findByTestID(root: TestRenderer.ReactTestInstance, testID: string) {
  return root.findAll(
    (node) => (node.type === TouchableOpacity || node.type === TextInput) && node.props?.testID === testID,
  );
}
function textContaining(root: TestRenderer.ReactTestInstance, needle: string) {
  return root.findAll((n) => n.type === Text && String((n.props as { children?: unknown }).children ?? '').includes(needle));
}

let renderer: TestRenderer.ReactTestRenderer | null = null;

beforeEach(() => {
  registerCalls = [];
  capturedPrompter = null;
  lastSheetProps = null;
});

afterEach(() => {
  if (renderer) {
    act(() => { renderer!.unmount(); });
    renderer = null;
  }
});

describe('ConfirmActionPrompt — mount/unmount registration', () => {
  test('registers on mount, unregisters (null) on unmount — unconditionally, no platform gate', () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });
    expect(registerCalls.length).toBe(1);
    expect(typeof registerCalls[0]).toBe('function');

    act(() => { renderer!.unmount(); });
    renderer = null;
    expect(registerCalls.length).toBe(2);
    expect(registerCalls[1]).toBeNull();
  });

  test('renders nothing before any prompt is requested', () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });
    expect(renderer!.toJSON()).toBeNull();
  });
});

describe('ConfirmActionPrompt — wrong password re-prompts INLINE (task 1610, Issue 2 round 2)', () => {
  test('retry keeps the same sheet open, clears the password, swaps the message — promise stays unresolved', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });

    let attemptCalls = 0;
    let settledToken: string | null | undefined;
    let promise: Promise<string | null>;
    act(() => {
      promise = capturedPrompter!({
        title: 'Confirm with password',
        message: 'Re-enter your password to authorize this action.',
        attempt: async (password: string) => {
          attemptCalls += 1;
          return { ok: false, retry: true, message: 'Incorrect password. Please try again.' };
        },
      });
      promise.then((t) => { settledToken = t; });
    });

    // Sheet is up, empty password field, Confirm disabled (nothing typed).
    expect(lastSheetProps!.visible).toBe(true);
    const input = findByTestID(renderer!.root, 'confirm-action-password-input');
    expect(input.length).toBe(1);
    expect(input[0].props.value).toBe('');

    act(() => { input[0].props.onChangeText('wrongpass'); });
    await act(async () => {
      findByTestID(renderer!.root, 'confirm-action-confirm')[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(attemptCalls).toBe(1);
    // Still the SAME open sheet — never dismissed, never a fresh mount.
    expect(lastSheetProps!.visible).toBe(true);
    // Password cleared, the retry message now showing.
    expect(findByTestID(renderer!.root, 'confirm-action-password-input')[0].props.value).toBe('');
    expect(textContaining(renderer!.root, 'Incorrect password. Please try again.').length).toBeGreaterThan(0);
    // The caller's promise has NOT settled — a wrong password never hands
    // back a result, retryable or otherwise.
    expect(settledToken).toBeUndefined();

    // A second, correct attempt now succeeds through the SAME sheet.
    act(() => {
      findByTestID(renderer!.root, 'confirm-action-password-input')[0].props.onChangeText('correct');
    });
    await act(async () => {
      findByTestID(renderer!.root, 'confirm-action-confirm')[0].props.onPress();
      await Promise.resolve();
    });
  });
});

describe('ConfirmActionPrompt — fatal errors show an in-app surface (task 1610, Issue 2 round 2)', () => {
  test('session-too-old: title+message inline, no password field, single OK — not Alert', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });

    let settledToken: string | null | undefined;
    act(() => {
      const promise = capturedPrompter!({
        title: 'Confirm with password',
        message: 'Re-enter your password to authorize this action.',
        attempt: async () => ({
          ok: false,
          retry: false,
          title: 'Please log out and back in',
          message: 'For security, this action requires a fresh login. Your data is safe.',
        }),
      });
      promise.then((t) => { settledToken = t; });
    });

    act(() => {
      findByTestID(renderer!.root, 'confirm-action-password-input')[0].props.onChangeText('whatever');
    });
    await act(async () => {
      findByTestID(renderer!.root, 'confirm-action-confirm')[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Fatal phase: password field and Cancel/Confirm are gone, replaced by
    // the fatal title/message and a single OK.
    expect(findByTestID(renderer!.root, 'confirm-action-password-input').length).toBe(0);
    expect(findByTestID(renderer!.root, 'confirm-action-cancel').length).toBe(0);
    expect(findByTestID(renderer!.root, 'confirm-action-confirm').length).toBe(0);
    expect(textContaining(renderer!.root, 'Please log out and back in').length).toBeGreaterThan(0);
    expect(textContaining(renderer!.root, 'For security, this action requires a fresh login').length).toBeGreaterThan(0);
    const ok = findByTestID(renderer!.root, 'confirm-action-ok');
    expect(ok.length).toBe(1);

    // Not resolved yet — OK only STARTS the close.
    expect(settledToken).toBeUndefined();

    act(() => { ok[0].props.onPress(); });
    // Visible flips false (close animation "starts")...
    expect(lastSheetProps!.visible).toBe(false);
    // ...but the promise is STILL unresolved — this is the race-safety
    // property: nothing may act on the result until the sheet is actually
    // gone.
    expect(settledToken).toBeUndefined();

    // The close animation "finishes" — BottomSheet fires onDismissed.
    await act(async () => {
      (lastSheetProps!.onDismissed as () => void)();
      await Promise.resolve();
    });
    expect(settledToken).toBeNull();
  });
});

describe('ConfirmActionPrompt — resolve happens only after dismissal (task 1610, Issue 2 round 2)', () => {
  test('success: Confirm decides the token, but the promise resolves only once onDismissed fires', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });

    let settledToken: string | null | undefined;
    act(() => {
      const promise = capturedPrompter!({
        title: 'Confirm with password',
        message: 'msg',
        attempt: async () => ({ ok: true, token: 'tok-xyz' }),
      });
      promise.then((t) => { settledToken = t; });
    });

    act(() => {
      findByTestID(renderer!.root, 'confirm-action-password-input')[0].props.onChangeText('correct');
    });
    await act(async () => {
      findByTestID(renderer!.root, 'confirm-action-confirm')[0].props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The attempt has settled (ok:true) and the sheet has started closing...
    expect(lastSheetProps!.visible).toBe(false);
    // ...but the token has NOT been handed back yet.
    expect(settledToken).toBeUndefined();

    await act(async () => {
      (lastSheetProps!.onDismissed as () => void)();
      await Promise.resolve();
    });
    expect(settledToken).toBe('tok-xyz');
  });

  test('cancel: resolves null, also only after onDismissed', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });

    let settledToken: string | null | undefined;
    act(() => {
      const promise = capturedPrompter!({
        title: 'Confirm with password',
        message: 'msg',
        attempt: async () => ({ ok: true, token: 'unused' }),
      });
      promise.then((t) => { settledToken = t; });
    });

    act(() => {
      findByTestID(renderer!.root, 'confirm-action-cancel')[0].props.onPress();
    });
    expect(lastSheetProps!.visible).toBe(false);
    expect(settledToken).toBeUndefined();

    await act(async () => {
      (lastSheetProps!.onDismissed as () => void)();
      await Promise.resolve();
    });
    expect(settledToken).toBeNull();
  });
});

describe('ConfirmActionPrompt — dismissal is blocked mid-submit (Codex P1, PR #157 round 2)', () => {
  test('scrim/drag dismiss (BottomSheet onRequestClose) while an attempt is in flight is a no-op — it cannot race a late success into handing back a token the user tried to cancel', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });

    // A deferred attempt: submit() awaits this, and the test controls
    // exactly when it settles — the only way to reliably land a dismiss
    // request WHILE `phase === 'submitting'`.
    let resolveAttempt: (outcome: unknown) => void = () => {};
    const attemptPromise = new Promise((resolve) => { resolveAttempt = resolve; });

    let settledToken: string | null | undefined;
    act(() => {
      const promise = capturedPrompter!({
        title: 'Confirm with password',
        message: 'msg',
        attempt: async () => attemptPromise,
      });
      promise.then((t) => { settledToken = t; });
    });

    act(() => {
      findByTestID(renderer!.root, 'confirm-action-password-input')[0].props.onChangeText('correct');
    });
    act(() => {
      findByTestID(renderer!.root, 'confirm-action-confirm')[0].props.onPress();
    });
    // Now mid-submit: the attempt is in flight and has not resolved yet.
    expect(lastSheetProps!.visible).toBe(true);

    // The scrim / drag-to-dismiss path — NOT the (already-disabled) Cancel
    // button — fires BottomSheet's own onRequestClose. Pre-fix, this called
    // `finish(null)` unconditionally and started the close animation.
    act(() => {
      (lastSheetProps!.onRequestClose as () => void)();
    });
    // Blocked: still visible, nothing decided yet.
    expect(lastSheetProps!.visible).toBe(true);
    expect(settledToken).toBeUndefined();

    // The in-flight attempt now succeeds (a real password, correctly
    // submitted before the user's dismiss attempt landed).
    await act(async () => {
      resolveAttempt({ ok: true, token: 'tok-real' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lastSheetProps!.visible).toBe(false);
    expect(settledToken).toBeUndefined(); // still not resolved — onDismissed hasn't fired

    await act(async () => {
      (lastSheetProps!.onDismissed as () => void)();
      await Promise.resolve();
    });
    // The blocked dismiss did not silently turn into a cancel once the
    // request settled — the real outcome (success) is what's honored.
    expect(settledToken).toBe('tok-real');
  });

  test('the Modal-level onRequestClose (hardware back / iOS swipe) is gated the same way', async () => {
    act(() => {
      renderer = TestRenderer.create(React.createElement(ConfirmActionPrompt));
    });
    let resolveAttempt: (outcome: unknown) => void = () => {};
    const attemptPromise = new Promise((resolve) => { resolveAttempt = resolve; });
    act(() => {
      capturedPrompter!({ title: 't', message: 'm', attempt: async () => attemptPromise });
    });
    act(() => {
      findByTestID(renderer!.root, 'confirm-action-password-input')[0].props.onChangeText('x');
    });
    act(() => {
      findByTestID(renderer!.root, 'confirm-action-confirm')[0].props.onPress();
    });

    // Modal and BottomSheet are wired to the SAME `cancel` — asserting the
    // Modal's own onRequestClose prop directly (rather than BottomSheet's)
    // proves the gate lives in `cancel` itself, not duplicated per caller.
    const modalNode = renderer!.root.findByType(Modal);
    act(() => { (modalNode.props.onRequestClose as () => void)(); });
    expect(lastSheetProps!.visible).toBe(true);

    await act(async () => { resolveAttempt({ ok: true, token: 'tok-2' }); await Promise.resolve(); await Promise.resolve(); });
    expect(lastSheetProps!.visible).toBe(false);
  });
});

// ── Source-text guard: the permanent, RED-provable lock that the native
// Alert path never comes back (mirrors NewFileSheet.test.ts's convention
// of asserting on the raw source for things a fake-RN render can't see). ──
describe('ConfirmActionPrompt — source guards', () => {
  const src = readFileSync(new URL('./ConfirmActionPrompt.tsx', import.meta.url), 'utf-8');

  test('never imports or calls Alert.alert / Alert.prompt', () => {
    // Scoped to actual usage, not the doc comment's prose mention of "Alert"
    // above — the import list and any `Alert.…(` call site.
    const importBlock = src.match(/import \{([\s\S]*?)\} from 'react-native';/);
    expect(importBlock).not.toBeNull();
    expect(importBlock![1]).not.toMatch(/\bAlert\b/);
    expect(src).not.toMatch(/\bAlert\.(alert|prompt)\(/);
  });

  test('resolve() is only ever called from onDismissed, never from finish()/submit()', () => {
    // `finish` decides the outcome and flips `visible` — it must not itself
    // resolve anything.
    const finishBody = src.match(/const finish = useCallback\(\(token: string \| null\) => \{([\s\S]*?)\}, \[\]\);/);
    expect(finishBody).not.toBeNull();
    expect(finishBody![1]).not.toContain('.resolve(');
    // `onDismissed` is the one place `.resolve(` appears.
    const resolveSites = src.match(/\.resolve\(/g) ?? [];
    expect(resolveSites.length).toBe(1);
    const onDismissedBody = src.match(/const onDismissed = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
    expect(onDismissedBody).not.toBeNull();
    expect(onDismissedBody![1]).toContain('.resolve(');
  });

  test('registers unconditionally — no Platform.OS gate', () => {
    expect(src).not.toContain('Platform');
  });

  test('cancel() is gated on phase === "submitting" — every dismissal path (Codex P1)', () => {
    const cancelBody = src.match(/const cancel = useCallback\(\(\) => \{([\s\S]*?)\}, \[finish, phase\]\);/);
    expect(cancelBody).not.toBeNull();
    expect(cancelBody![1]).toMatch(/phase === 'submitting'/);
    // Both onRequestClose props (Modal + BottomSheet) route through this
    // SAME `cancel` — not a separate, ungated handler for either.
    expect(src.match(/onRequestClose=\{cancel\}/g) ?? []).toHaveLength(2);
  });
});
