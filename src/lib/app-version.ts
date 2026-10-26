import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Already linked via expo-notifications. Web / test hosts may have no native
// module; only those hosts use the embedded config fallback.
let application: Pick<typeof import('expo-application'), 'nativeApplicationVersion' | 'nativeBuildVersion'> | null = null;
try { application = require('expo-application'); } catch {}

/** Installed binary identity. Keep the wire version separate from the UI build. */
export function appVersion(): { version: string; build: string } {
  const config = Constants.expoConfig;
  const configBuild = Platform.OS === 'android' ? config?.android?.versionCode : config?.ios?.buildNumber;
  return {
    version: application?.nativeApplicationVersion ?? config?.version ?? '1.0.0',
    build: application?.nativeBuildVersion ?? String(configBuild ?? '1'),
  };
}
