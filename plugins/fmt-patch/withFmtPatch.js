const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Patches Pods/.../fmt/{core,format}.h after `pod install` so that fmt's
// `consteval` helpers compile under Xcode's clang (which evaluates them as
// C++17). Without this, every clean prebuild needs a manual edit before
// `pod install` succeeds.
module.exports = function withFmtPatch(config) {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(podfilePath, 'utf8');

      if (podfile.includes('@beebeeb-fmt-patch')) {
        return config;
      }

      const patchCode = `
    # @beebeeb-fmt-patch — fmt consteval → constexpr for Xcode compatibility
    Dir.glob("#{installer.sandbox.root}/**/fmt/core.h").each do |file|
      content = File.read(file)
      if content.include?('consteval')
        File.write(file, content.gsub('consteval', 'constexpr'))
      end
    end
    Dir.glob("#{installer.sandbox.root}/**/fmt/format.h").each do |file|
      content = File.read(file)
      if content.include?('consteval')
        File.write(file, content.gsub('consteval', 'constexpr'))
      end
    end`;

      const next = podfile.replace(
        /(post_install do \|installer\|[\s\S]*?)(^\s*end\s*$\s*end)/m,
        `$1${patchCode}\n$2`,
      );

      if (next === podfile) {
        console.warn('[fmt-patch] WARNING: could not locate post_install block in Podfile');
        return config;
      }

      fs.writeFileSync(podfilePath, next);
      return config;
    },
  ]);
};
