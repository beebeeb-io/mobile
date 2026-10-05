/**
 * First-run marker for the Welcome screen (task 1746, absorbs the "how it works"
 * part of 1703). SecureStore, best effort: if it cannot be read or written the
 * Welcome screen is simply not shown again on a read failure and shown once more on
 * a write failure. Never throws.
 *
 * Existing installs are never sent through it: App.tsx marks it as seen the moment
 * a session exists, so an upgrading user who signs out later lands on Login.
 */
import * as SecureStore from 'expo-secure-store';

export const WELCOME_SEEN_KEY = 'beebeeb_welcome_seen';

/** True when the Welcome screen has been seen (or could not be checked). */
export async function readWelcomeSeen(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(WELCOME_SEEN_KEY)) === '1';
  } catch {
    // Unreadable store: do not trap anyone behind a screen they cannot dismiss.
    return true;
  }
}

export async function markWelcomeSeen(): Promise<void> {
  try {
    await SecureStore.setItemAsync(WELCOME_SEEN_KEY, '1');
  } catch {
    /* best effort */
  }
}
