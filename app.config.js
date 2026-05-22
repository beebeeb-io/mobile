const app = require('./app.json');

const config = app.expo;
const projectId = config.extra?.eas?.projectId;

module.exports = {
  ...config,
  updates: {
    ...config.updates,
    url: `https://u.expo.dev/${projectId}`,
  },
  runtimeVersion: config.runtimeVersion ?? config.version,
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? config.extra?.apiUrl,
  },
};
