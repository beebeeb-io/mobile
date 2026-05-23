const app = require('./app.json');

const config = app.expo;
const projectId = config.extra?.eas?.projectId;

// Dev / sim verification flag — when EXPO_NO_OTA_UPDATES=1 the app does NOT
// fetch its JS bundle from the EAS CDN on launch, so EXPO_PUBLIC_API_URL
// actually takes effect (instead of being overridden by the CDN bundle's
// baked-in apiUrl). Use for local verification against a localhost API.
const otaUpdatesDisabled = process.env.EXPO_NO_OTA_UPDATES === '1';

module.exports = {
  ...config,
  updates: otaUpdatesDisabled
    ? { enabled: false, checkOnLaunch: 'NEVER' }
    : {
        ...config.updates,
        url: `https://u.expo.dev/${projectId}`,
      },
  runtimeVersion: config.runtimeVersion ?? config.version,
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? config.extra?.apiUrl,
  },
};
