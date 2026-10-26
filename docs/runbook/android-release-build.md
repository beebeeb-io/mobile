# Android release build — L3, 2026-10-26

Owner: Codex L3, solo. Branch: `fs/l3-android/release-build`.
Worktree: `/Users/guuslangelaar/code/bb-worktrees/fs-l3-android-release`.
Base: mobile origin/main `8d34524`. Handoff: lead reviews/merges and signs through EAS; no merge or Play upload here.

Decision: Keep the committed native project; run Android-only Expo prebuild, review the diff, preserve native modules, hardening and permissions, and track generated splash PNGs with a narrow ignore exception. iOS native files remain outside this lane. Block AD_ID in the config plugin and generated manifest per Guus's Play declaration.

Verification: JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew :app:bundleRelease (inside android); npx expo-doctor; bun run test (isolated count); bunx tsc --noEmit; dump the built bundle manifest and enumerate permissions, requiring AD_ID absent. No emulator/device runs or credential/signing configuration edits. Local release uses the template debug signing configuration; EAS upload signing stays with the lead.

Evidence directory: `/Users/guuslangelaar/code/bb-gate-logs/fullspeed/`, prefix `l3-`.

Decision: Disable only expo-doctor's non-CNG field warning: this repository intentionally commits native projects with custom iOS targets and Android modules. EAS must build those projects, not discard them. Android config changes are applied with `bunx expo prebuild --platform android --no-clean --no-install` and reviewed/committed. The other doctor checks remain enabled. Expo SDK 57 dependencies and the missing expo-asset peer are aligned using expo install; expo-asset/font plugins are explicitly registered.

Correction: SDK 57 prebuild recreates native folders by default (`clean: !args['--no-clean']`); the initial invocations without --no-clean regenerated android/. Use --no-clean for subsequent config synchronization. Reviewed the full native diff: all committed custom modules unchanged; no existing uses-permission removed; restored MaterialComponents theme and main/debug loopback network policy via the config plugin. Native app/runtime versions now match 1.0.1. No iOS native files changed.

Graphify update attempted: 780 code files extracted; its safety check refused replacing the 23,908-node graph with a 7,211-node graph. Existing graph retained; generated conversion scratch is outside the PR.

Validation so far:
- expo-doctor: 20/20 enabled checks passed (non-CNG warning intentionally disabled as explained above).
- isolated: 2963 pass, 0 fail across 282 files; `l3-isolated.log`, exit 0.
- bunx tsc --noEmit: exit 0 (`l3-tsc.log`).
- Regression: initial splash/manifest check 1 pass, 2 fail; repaired 3 pass, 0 fail. Removing the plugin AD_ID block gives 2 pass, 1 fail at the exact plugin assertion (`l3-plugin-mutation-red.log`); restored 3 pass, 0 fail.
- Native audit: 18/18 existing uses-permission declarations retained; 0 removed; AD_ID removal directive added. All 87 tracked module files present and no modules/ or ios/ diff.
- git diff --check: exit 0.

Compatibility: no server/API changes; existing and new servers use the same client contract. Dependency changes affect both platforms: iOS Pod installation/build must be run by L1/lead before its next release; iOS native regeneration and device QA are outside this Android build slice. Expo prebuild still warns that automatic userInterfaceStyle needs expo-system-ui; no unrelated dependency added for that warning.

Release result: `BUILD SUCCESSFUL in 4m 49s`; `:app:bundleRelease`, exit 0, `l3-gradle-release.log` (1,140 actionable tasks). Local bundle `android/app/build/outputs/bundle/release/app-release.aab` (78443512 bytes), SHA256 `9ccf9367f66f65226da8696960c49e2f52b7889b3305dea9e2d80506bda115e8`. Kotlin daemon could not write to the sandboxed user cache; Gradle's in-process fallback completed.

Bundletool 1.18.2 dumped the manifest from the completed AAB, exit 0 (`l3-bundle-manifest.xml`). 42 requested permissions; AD_ID, RECORD_AUDIO and SYSTEM_ALERT_WINDOW absent; allowBackup false; network security policy present.

Merged permission list:

- `android.permission.ACCESS_NETWORK_STATE`
- `android.permission.ACCESS_WIFI_STATE`
- `android.permission.CAMERA`
- `android.permission.DETECT_SCREEN_CAPTURE`
- `android.permission.DOWNLOAD_WITHOUT_NOTIFICATION`
- `android.permission.INTERNET`
- `android.permission.MODIFY_AUDIO_SETTINGS`
- `android.permission.POST_NOTIFICATIONS`
- `android.permission.READ_APP_BADGE`
- `android.permission.READ_CALENDAR`
- `android.permission.READ_CONTACTS`
- `android.permission.READ_EXTERNAL_STORAGE`
- `android.permission.READ_MEDIA_AUDIO`
- `android.permission.READ_MEDIA_IMAGES`
- `android.permission.READ_MEDIA_VIDEO`
- `android.permission.READ_MEDIA_VISUAL_USER_SELECTED`
- `android.permission.RECEIVE_BOOT_COMPLETED`
- `android.permission.USE_BIOMETRIC`
- `android.permission.USE_FINGERPRINT`
- `android.permission.VIBRATE`
- `android.permission.WAKE_LOCK`
- `android.permission.WRITE_CALENDAR`
- `android.permission.WRITE_CONTACTS`
- `android.permission.WRITE_EXTERNAL_STORAGE`
- `com.anddoes.launcher.permission.UPDATE_COUNT`
- `com.google.android.c2dm.permission.RECEIVE`
- `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`
- `com.htc.launcher.permission.READ_SETTINGS`
- `com.htc.launcher.permission.UPDATE_SHORTCUT`
- `com.huawei.android.launcher.permission.CHANGE_BADGE`
- `com.huawei.android.launcher.permission.READ_SETTINGS`
- `com.huawei.android.launcher.permission.WRITE_SETTINGS`
- `com.majeur.launcher.permission.UPDATE_BADGE`
- `com.oppo.launcher.permission.READ_SETTINGS`
- `com.oppo.launcher.permission.WRITE_SETTINGS`
- `com.sec.android.provider.badge.permission.READ`
- `com.sec.android.provider.badge.permission.WRITE`
- `com.sonyericsson.home.permission.BROADCAST_BADGE`
- `com.sonymobile.home.permission.PROVIDER_INSERT_BADGE`
- `io.beebeeb.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`
- `me.everything.badger.permission.BADGE_COUNT_READ`
- `me.everything.badger.permission.BADGE_COUNT_WRITE`

## Lead correction — Android-only, 2026-10-26

The earlier shared Expo patch alignment decision is superseded: iOS is the launch platform. Restore package.json, bun.lock, app.json and app.config.js to the PR base. No dependency changes or extra expo-asset/expo-font plugins are needed for the tracked Android splash resources. Keep Android resources, AD_ID removal/plugin regression and native Android sync. The earlier 20/20 doctor claim describes the superseded dependency set. Follow-up: **SDK patch alignment, task to file**; version-mismatch warnings are acceptable for this Android-only PR.

Owner: Codex L3 solo, fresh worktree `/Users/guuslangelaar/code/bb-worktrees/fs-l3-218-android-only`. Verification for this correction: Java 17 Android release bundle, local `ios/pod install` without iOS prebuild, isolated runner, TypeScript and exact comparison with the previous 42-permission bundle list. No credentials or keystore edits.

Correction evidence: `l3-218-isolated.log`: **isolated: 2963 pass, 0 fail across 282 files**, exit 0. `l3-218-tsc.log`: `bunx tsc --noEmit`, exit 0. Local `pod install` succeeded in 141 seconds: **135 Podfile dependencies, 139 total pods** (`l3-218-pod-retry.log`, exit 0); only `CP_CACHE_DIR`/`TMPDIR` were redirected into the writable lane evidence directory after the default cache was denied by the sandbox. No iOS prebuild ran; the vendored framework, bindings, widget, privacy file and ENTRY_FILE pin were unchanged. CocoaPods' generated project ordering and Podfile checksum churn were restored before committing; no iOS changes are included. Package/config byte equality against base is recorded in `l3-218-verification.txt`.

Android correction validation: the exact default `./gradlew :app:bundleRelease` compiled the reverted dependency set but failed `:app:validateSigningRelease` because this fresh worktree has no ignored `android/app/debug.keystore` (`l3-218-gradle.log`). To respect the explicit no-keystore instruction, no keystore was opened/copied/generated/changed. A temporary external init script disables release signing only for the local verification invocation: `./gradlew :app:bundleRelease --init-script /Users/guuslangelaar/code/bb-gate-logs/fullspeed/l3-218-unsigned.gradle`. This produced **BUILD SUCCESSFUL in 22s**, exit 0, **1139 actionable tasks: 44 executed, 1095 up-to-date** (`l3-218-gradle-unsigned.log`). No signing changes are committed. The default signed command remains an explicit validation gap requiring the lead's signing-equipped runner.

Bundletool verified the resulting unsigned AAB: **42 permissions, 0 added, 0 removed**, exact equality with `l3-permissions.txt`; AD_ID absent, allowBackup=false (`l3-218-bundle-manifest.xml`, `l3-218-permissions.txt`). The successful build uses no dependency/plugin additions; all four shared package/config files are identical to the PR base. No iOS app build or device/simulator runs were performed in this correction; the required CI iOS build will run on the pushed head.
