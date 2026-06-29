const app = require('./app.json');

const config = app.expo;

module.exports = {
  ...config,
  // EAS OTA Updates are DISABLED (task 0879). The EAS update CDN (u.expo.dev) is
  // US-hosted, which conflicts with beebeeb's EU-sovereignty posture (no US systems
  // in the data path). The app therefore ships ONLY via signed TestFlight / App
  // Store binaries — it never fetches a JS bundle from a US server at runtime.
  // Re-enable only behind an EU-hosted self-hosted expo-updates server.
  updates: { enabled: false, checkOnLaunch: 'NEVER' },
  runtimeVersion: config.runtimeVersion ?? config.version,
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? config.extra?.apiUrl,
  },
};
