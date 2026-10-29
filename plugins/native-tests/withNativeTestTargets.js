const { withXcodeProject } = require('@expo/config-plugins');
const { ensureXCTestTarget } = require('../lib/xctest-target');

// Canonical sources live at targets/native-tests/ (task 1562, moved out of
// ios/BeebeebNativeTests/) and are referenced directly from there — never
// copied into ios/ — the same "reference the file where it lives" pattern
// plugins/file-provider/withFileProvider.js already uses for its own Swift
// sources. `expo prebuild --clean` wipes the whole ios/ tree before
// regenerating it, so anything that lives ONLY inside ios/ (as these two
// XCTest targets did before this plugin existed — hand-added straight into
// project.pbxproj, task 1382/1439) is destroyed on every clean prebuild with
// no warning short of `scripts/kat-ios.sh` failing outright ("scheme not
// found"). See CLAUDE.md "expo prebuild — ALWAYS run the vendored-file
// restore afterwards" for the full incident history.
const PROVENANCE_HEADERS_TESTS = {
  name: 'ProvenanceHeadersTests',
  bundleId: 'io.beebeeb.app.ProvenanceHeadersTests',
  deploymentTarget: '16.0',
  linkRustFramework: false,
  groupChildren: [
    { path: '../targets/native-tests/ProvenanceHeadersTests.swift', name: 'ProvenanceHeadersTests.swift' },
  ],
  sources: [
    { path: '../targets/native-tests/ProvenanceHeadersTests.swift', name: 'ProvenanceHeadersTests.swift' },
    // The helper under test — same canonical file the app, Share extension
    // and File Provider extension all compile directly (no per-target
    // duplicate copy); see CRYPTO_SHARED_FILES in withShareExtension.js /
    // withFileProvider.js and ProvenanceHeaders.swift's own doc comment.
    { path: '../modules/beebeeb-crypto/ios/ProvenanceHeaders.swift', name: 'ProvenanceHeaders.swift' },
  ],
};

const CORE_VECTORS_KAT_TESTS = {
  name: 'CoreVectorsKATTests',
  bundleId: 'io.beebeeb.app.CoreVectorsKATTests',
  deploymentTarget: '16.0',
  linkRustFramework: true,
  groupChildren: [
    { path: '../targets/native-tests/CoreVectorsKATTests.swift', name: 'CoreVectorsKATTests.swift' },
    {
      name: 'Vectors',
      files: [
        { path: '../targets/native-tests/Vectors/core-vectors.v4.json', name: 'core-vectors.v4.json', fileType: 'text.json' },
      ],
    },
  ],
  sources: [
    { path: '../targets/native-tests/CoreVectorsKATTests.swift', name: 'CoreVectorsKATTests.swift' },
    // Compiles the SAME production UniFFI Swift bindings the app links (task
    // 1382) — vendored/restored at ios/Beebeeb/beebeeb_uniffi.swift by
    // scripts/restore-vendored-ios.sh after every prebuild, exactly like the
    // app target and every extension target that links the Rust core.
    { path: 'Beebeeb/beebeeb_uniffi.swift', name: 'beebeeb_uniffi.swift' },
  ],
  resources: [
    { path: '../targets/native-tests/Vectors/core-vectors.v4.json', name: 'core-vectors.v4.json' },
  ],
};

function withNativeTestTargets(config) {
  return withXcodeProject(config, async (config) => {
    const project = config.modResults;
    ensureXCTestTarget(project, PROVENANCE_HEADERS_TESTS);
    ensureXCTestTarget(project, CORE_VECTORS_KAT_TESTS);
    console.log('[NativeTestTargets] ProvenanceHeadersTests + CoreVectorsKATTests ensured in Xcode project');
    return config;
  });
}

module.exports = withNativeTestTargets;
