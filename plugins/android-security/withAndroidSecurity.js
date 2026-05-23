const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Expo config plugin that hardens the Android manifest for a zero-knowledge
 * vault app:
 *
 * 1. Sets android:allowBackup="false" — device backups must NOT include app
 *    data. Users restore from the server via their encryption key.
 *
 * 2. Removes RECORD_AUDIO and SYSTEM_ALERT_WINDOW permissions that leak in
 *    from transitive dependencies. Neither is needed by Beebeeb.
 */
module.exports = function withAndroidSecurity(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;

    // --- 1. Disable allowBackup on <application> ---
    const application = manifest.application?.[0];
    if (application?.$) {
      application.$['android:allowBackup'] = 'false';
    }

    // --- 2. Remove unnecessary permissions ---
    const removePermissions = [
      'android.permission.RECORD_AUDIO',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ];

    if (manifest['uses-permission']) {
      manifest['uses-permission'] = manifest['uses-permission'].filter(
        (perm) => !removePermissions.includes(perm.$?.['android:name']),
      );
    }

    return config;
  });
};
