/**
 * Siri Shortcuts integration for Beebeeb.
 *
 * How it works in managed Expo:
 * - NSUserActivityTypes is declared in app.json so iOS knows the app handles
 *   these activity identifiers. This allows the Shortcuts app to suggest
 *   "Open URL" shortcuts with the beebeeb:// scheme.
 * - When the user performs an action (upload, search, scan) we call
 *   donateSiriShortcut so iOS can learn the pattern and surface it as a
 *   Siri suggestion or lock-screen shortcut.
 * - Full NSUserActivity donation requires native modules (bare workflow).
 *   In managed Expo we log the donation intent; when/if we eject or add a
 *   custom native module this file is the single integration point to update.
 *
 * Deep-link URLs handled by FilesScreen:
 *   beebeeb://upload  — opens the file picker
 *   beebeeb://search  — opens the search bar
 *   beebeeb://scan    — opens the document scanner
 *
 * Users can add any of these as Siri Shortcuts manually:
 *   Shortcuts.app → + → Open URL → beebeeb://upload → Add to Siri
 */

export type SiriAction = 'upload' | 'search' | 'scan';

interface ShortcutMeta {
  activityType: string;
  title: string;
  url: string;
  keywords: string[];
}

const SHORTCUT_META: Record<SiriAction, ShortcutMeta> = {
  upload: {
    activityType: 'io.beebeeb.app.upload',
    title: 'Upload to Beebeeb',
    url: 'beebeeb://upload',
    keywords: ['upload', 'file', 'encrypt', 'beebeeb'],
  },
  search: {
    activityType: 'io.beebeeb.app.search',
    title: 'Search Beebeeb',
    url: 'beebeeb://search',
    keywords: ['search', 'find', 'file', 'beebeeb'],
  },
  scan: {
    activityType: 'io.beebeeb.app.scan',
    title: 'Scan Document',
    url: 'beebeeb://scan',
    keywords: ['scan', 'document', 'camera', 'beebeeb'],
  },
};

/**
 * Donate a Siri shortcut for the given action.
 *
 * iOS uses donations to learn which actions the user performs frequently and
 * surface them as Siri suggestions on the lock screen, search, and Shortcuts
 * app. Call this immediately after the user completes (or initiates) the
 * corresponding action — not before.
 *
 * In managed Expo this is a no-op aside from logging; a bare-workflow native
 * module (e.g. react-native-siri-shortcut or a custom Swift module) can be
 * dropped in here without changing call sites.
 */
export function donateSiriShortcut(action: SiriAction): void {
  const meta = SHORTCUT_META[action];
  if (__DEV__) {
    console.log(
      `[Siri] Donating shortcut: ${meta.activityType} ("${meta.title}", url=${meta.url})`,
    );
  }
  // Native donation stub — replace with NativeModules.SiriShortcuts.donate(meta)
  // when a native module is available. The activityType must match one of the
  // NSUserActivityTypes declared in app.json for iOS to accept the donation.
}

/** Metadata for a shortcut action (used by the settings deep-link UI). */
export function getShortcutMeta(action: SiriAction): ShortcutMeta {
  return SHORTCUT_META[action];
}
