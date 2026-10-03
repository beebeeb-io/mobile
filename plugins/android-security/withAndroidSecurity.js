const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Expo config plugin that hardens the Android manifest for a zero-knowledge
 * vault app:
 *
 * 1. Sets android:allowBackup="false" — device backups must NOT include app
 *    data. Users restore from the server via their encryption key.
 *
 * 2. Removes RECORD_AUDIO and SYSTEM_ALERT_WINDOW. Neither is needed by
 *    Beebeeb (playback-only audio; no overlay windows), but several Expo
 *    plugins add RECORD_AUDIO by default (expo-camera, expo-image-picker,
 *    expo-audio) and library manifests can re-add it. This plugin strips the
 *    plain declarations AND appends `tools:node="remove"` directives so the
 *    manifest merger removes them from every library manifest as well.
 */
const STRIPPED_PERMISSIONS = [
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
];

module.exports = function withAndroidSecurity(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // --- 1. Disable allowBackup on <application> ---
    const application = manifest.application?.[0];
    if (application?.$) {
      application.$['android:allowBackup'] = 'false';
    }

    // --- 2. Strip permissions at prebuild time and at merge time ---
    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }

    manifest['uses-permission'] = manifest['uses-permission'].filter(
      (perm) => !STRIPPED_PERMISSIONS.includes(perm.$?.['android:name']),
    );

    for (const name of STRIPPED_PERMISSIONS) {
      const alreadyBlocked = manifest['uses-permission'].some(
        (perm) => perm.$?.['android:name'] === name && perm.$?.['tools:node'] === 'remove',
      );
      if (!alreadyBlocked) {
        manifest['uses-permission'].push({
          $: {
            'android:name': name,
            'tools:node': 'remove',
          },
        });
      }
    }

    return config;
  });
};
