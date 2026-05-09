const app = require('./app.json');

const config = app.expo;

module.exports = {
  ...config,
  extra: {
    ...config.extra,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? config.extra?.apiUrl,
  },
};
