const { withAndroidManifest, withAndroidStyles, withDangerousMod } = require('@expo/config-plugins');
const { copyFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

/**
 * Expo config plugin that hardens the Android manifest for a zero-knowledge
 * vault app:
 *
 * 1. Sets android:allowBackup="false" — device backups must NOT include app
 *    data. Users restore from the server via their encryption key.
 *
 * 2. Removes AD_ID, RECORD_AUDIO and SYSTEM_ALERT_WINDOW. These are not needed by
 *    Beebeeb (playback-only audio; no overlay windows), but several Expo
 *    plugins add RECORD_AUDIO by default (expo-camera, expo-image-picker,
 *    expo-audio) and library manifests can re-add it. AD_ID is blocked to
 *    match our Play no-advertising-ID declaration. This plugin strips plain
 *    declarations and appends `tools:node="remove"` directives so the manifest
 *    merger removes them from every library manifest as well.
 */
const STRIPPED_PERMISSIONS = [
  'com.google.android.gms.permission.AD_ID',
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
];

module.exports = function withAndroidSecurity(config) {
  config = withAndroidStyles(config, (config) => {
    const theme = config.modResults.resources.style?.find((style) => style.$.name === 'AppTheme');
    // Native bottom-tab badges require MaterialComponents (task 1683b).
    if (theme) theme.$.parent = 'Theme.MaterialComponents.DayNight.NoActionBar';
    return config;
  });
  config = withDangerousMod(config, ['android', (config) => {
    for (const variant of ['main', 'debug']) {
      const dir = path.join(config.modRequest.platformProjectRoot, 'app/src', variant, 'res/xml');
      mkdirSync(dir, { recursive: true });
      copyFileSync(path.join(__dirname, `network_security_config_${variant}.xml`), path.join(dir, 'network_security_config.xml'));
    }
    return config;
  }]);
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // --- 1. Disable allowBackup on <application> ---
    const application = manifest.application?.[0];
    if (application?.$) {
      application.$['android:allowBackup'] = 'false';
      application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
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
