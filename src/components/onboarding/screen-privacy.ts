/**
 * Screen privacy for the signup steps that put a secret on screen (task 1746, 1753
 * pass 2 hardening): the recovery phrase and its confirmation, and the password
 * while "Show password" is on. Best effort: a failure to arm protection must never
 * break the step, so every native call swallows its rejection.
 */
import { useEffect } from 'react';
import { allowScreenCaptureAsync, disableAppSwitcherProtectionAsync, enableAppSwitcherProtectionAsync, preventScreenCaptureAsync } from 'expo-screen-capture';

/** Blur the app-switcher snapshot while `active`. */
export function useAppSwitcherProtection(active: boolean = true): void {
  useEffect(() => {
    if (!active) return undefined;
    enableAppSwitcherProtectionAsync().catch(() => {});
    return () => {
      disableAppSwitcherProtectionAsync().catch(() => {});
    };
  }, [active]);
}

/** Block screenshots and screen recording while `active` (a hook that can be switched off, unlike `usePreventScreenCapture`). */
export function useCaptureGuard(key: string, active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    preventScreenCaptureAsync(key).catch(() => {});
    return () => {
      allowScreenCaptureAsync(key).catch(() => {});
    };
  }, [key, active]);
}
