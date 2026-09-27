import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Task 1578 — "Ask when a file changed on another device" (text editor Save).
 *
 * Ruling (lead, 2026-09-27, on Guus's request "make it an option but disabled
 * by default"): default OFF. OFF: a real stale-version conflict is saved as a
 * new version on top of the latest one — the other device's version stays in
 * version history, so nothing is lost — and a quiet toast says so. ON: the
 * existing conflict dialog (Keep both / Save as new version / Discard).
 *
 * Per-device, like the other editor/preview conveniences. A missing, corrupt or
 * unreadable value is OFF.
 */
const ASK_ON_CONFLICT_KEY = 'beebeeb:editor-ask-on-remote-change:v1';

export const DEFAULT_ASK_ON_REMOTE_CHANGE = false;

export async function getAskOnRemoteChange(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(ASK_ON_CONFLICT_KEY);
    return raw === 'true' ? true : DEFAULT_ASK_ON_REMOTE_CHANGE;
  } catch {
    return DEFAULT_ASK_ON_REMOTE_CHANGE;
  }
}

export async function setAskOnRemoteChange(value: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(ASK_ON_CONFLICT_KEY, value ? 'true' : 'false');
  } catch {
    // Non-fatal: the toggle simply does not persist on this device.
  }
}
