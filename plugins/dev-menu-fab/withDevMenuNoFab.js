const { withInfoPlist } = require('@expo/config-plugins');

/**
 * withDevMenuNoFab — disables expo-dev-menu's floating "Tools" gear button
 * in DEV-CLIENT builds only (task 1563 preview redesign, item 5).
 *
 * The gear sits fixed in the screen's top-right corner and exactly covers
 * PreviewScreen's own ⋯ ("Open file options") button — confirmed by direct
 * instrumentation in an earlier pass of this task (a console.log placed as
 * the first line of `handlePreviewOptions` never printed for any Maestro
 * tap/longPress/point-coordinate attempt on that button, while an adjacent
 * button using the identical touchable pattern fired every time). Maestro
 * cannot dismiss or route around the gear because it is a NATIVE overlay
 * added by expo-dev-menu itself, entirely outside the RN view tree Maestro
 * inspects.
 *
 * expo-dev-menu reads the `EXDevMenuShowFloatingActionButton` Info.plist
 * key as the REGISTERED UserDefaults default (`DevMenuPreferences.swift`,
 * `UserDefaults.standard.register(defaults: […])`) the first time the app
 * boots — it defaults to `true` (shown) when the key is absent. Setting it
 * to `false` here disables the gear for every dev-client build (Debug
 * config, `expo start`/`expo run:ios`) without touching how the module
 * itself gets linked.
 *
 * Scoped to dev-client only, by construction: `expo-dev-menu` (the native
 * module reading this key) is a devDependency that Expo excludes from
 * Release-configuration builds entirely — the key is inert (unread, since
 * the module isn't linked) in a TestFlight/App Store build, so this can
 * never change release behaviour, per this task's own constraint.
 *
 * Written as its own tiny plugin (this repo's established pattern for
 * small native tweaks — see ./plugins/fmt-patch, ./plugins/android-security)
 * rather than passed as expo-dev-launcher's own `ios.toolsButton` config
 * prop, so it takes effect regardless of whether expo-dev-launcher's plugin
 * is also applied via autolinking with no props (Info.plist mods from
 * different plugins all merge into the same `modResults`; placing this
 * plugin LAST in app.json's `plugins` array — see app.json — makes it the
 * final writer of this one key either way).
 */
module.exports = function withDevMenuNoFab(config) {
  return withInfoPlist(config, (config) => {
    config.modResults['EXDevMenuShowFloatingActionButton'] = false;
    return config;
  });
};
