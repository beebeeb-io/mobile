/**
 * Step-up re-auth helper for destructive operations.
 *
 * Prompts the user for their password, exchanges it for a short-lived
 * confirmation token via `confirmAction`, and returns the token (or `null`
 * if the user cancelled). Errors are surfaced via Alert and resolve to `null`.
 *
 * iOS uses native `Alert.prompt` (supports `secureTextEntry`).
 * Android falls back to a controlled Modal with a TextInput.
 */

import { Alert, Platform } from 'react-native';
import { confirmAction, friendlyError, IncorrectPasswordError } from './api';

let androidPrompter: ((title: string, message: string) => Promise<string | null>) | null = null;

/** Registered by `<ConfirmActionPrompt />` so this module can drive it. */
export function registerAndroidConfirmPrompter(
  fn: ((title: string, message: string) => Promise<string | null>) | null,
): void {
  androidPrompter = fn;
}

async function promptForPassword(title: string, message: string): Promise<string | null> {
  if (Platform.OS === 'ios') {
    return new Promise((resolve) => {
      Alert.prompt(
        title,
        message,
        [
          { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
          { text: 'Confirm', style: 'destructive', onPress: (value) => resolve(value ?? null) },
        ],
        'secure-text',
      );
    });
  }
  if (androidPrompter) return androidPrompter(title, message);
  // No prompter mounted — fail closed so we never silently bypass step-up.
  Alert.alert('Confirmation required', 'Password prompt is unavailable. Please try again.');
  return null;
}

/**
 * Prompt the user to re-enter their password, exchange it for a confirmation
 * token, and return the token. Returns `null` on cancel or any non-recoverable
 * error. On wrong password, re-prompts so the user can correct a typo without
 * having to re-trigger the destructive action.
 */
export async function requestConfirmation(opts?: {
  title?: string;
  message?: string;
}): Promise<string | null> {
  const title = opts?.title ?? 'Confirm with password';
  const message = opts?.message ?? 'Re-enter your password to authorize this action.';

  let promptMessage = message;
  // Loop on incorrect password; cancel/other errors break out.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const password = await promptForPassword(title, promptMessage);
    if (!password) return null;

    try {
      const { confirmation_token } = await confirmAction(password);
      return confirmation_token;
    } catch (err) {
      if (err instanceof IncorrectPasswordError) {
        promptMessage = 'Incorrect password. Please try again.';
        continue;
      }
      Alert.alert('Confirmation failed', friendlyError(err));
      return null;
    }
  }
}
