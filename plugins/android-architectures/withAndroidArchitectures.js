const { withGradleProperties } = require('@expo/config-plugins');

/**
 * Pins the Android ABIs we actually ship Rust `.so` artifacts for
 * (arm64-v8a + x86_64) in `android/gradle.properties`.
 *
 * Without this, debug builds merge all four template ABIs
 * (armeabi-v7a, arm64-v8a, x86, x86_64) and crash at the first FFI call
 * with `UnsatisfiedLinkError: library "libbeebeeb_uniffi.so" not found`
 * on the ABIs we do not build. A config plugin (rather than a manual
 * gradle.properties edit) keeps the pin alive across `expo prebuild --clean`.
 */
module.exports = function withAndroidArchitectures(config) {
  return withGradleProperties(config, (config) => {
    const key = 'reactNativeArchitectures';
    const value = 'arm64-v8a,x86_64';
    const props = config.modResults;
    const existing = props.find((item) => item.type === 'property' && item.key === key);

    if (existing) {
      existing.value = value;
    } else {
      props.push({ type: 'property', key, value });
    }

    return config;
  });
};
