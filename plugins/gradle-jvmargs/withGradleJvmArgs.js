const { withGradleProperties } = require('@expo/config-plugins');

/**
 * Raises the Gradle daemon JVM memory for Android builds.
 *
 * The RN/Expo template default (`-Xmx2048m -XX:MaxMetaspaceSize=512m`) is not
 * enough for `lintVitalAnalyzeRelease` on this app: lint workers run
 * in-process in the daemon and exhaust metaspace while analyzing the RN
 * library graph (`OutOfMemoryError: Metaspace` on react-native-blob-util,
 * react-native-community_netinfo and react-native-blurhash, 2026-10-02).
 * A config plugin (not a manual gradle.properties edit) keeps the value
 * alive across `expo prebuild --clean`.
 */
const JVM_ARGS = '-Xmx4096m -XX:MaxMetaspaceSize=1536m';

module.exports = function withGradleJvmArgs(config) {
  return withGradleProperties(config, (config) => {
    const key = 'org.gradle.jvmargs';
    const props = config.modResults;
    const existing = props.find((item) => item.type === 'property' && item.key === key);

    if (existing) {
      existing.value = JVM_ARGS;
    } else {
      props.push({ type: 'property', key, value: JVM_ARGS });
    }

    return config;
  });
};
