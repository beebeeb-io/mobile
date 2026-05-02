const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

module.exports = function withFmtPatch(config) {
  return withDangerousMod(config, ['ios', (config) => {
    const podfile = path.join(config.modRequest.platformProjectRoot, 'Podfile');
    let content = fs.readFileSync(podfile, 'utf8');

    const patch = `
    # Patch fmt consteval for Xcode compatibility
    Dir.glob("#{installer.sandbox.root}/**/fmt/core.h").each do |f|
      c = File.read(f)
      File.write(f, c.gsub('consteval', 'constexpr')) if c.include?('consteval')
    end
    Dir.glob("#{installer.sandbox.root}/**/fmt/format.h").each do |f|
      c = File.read(f)
      File.write(f, c.gsub('consteval', 'constexpr')) if c.include?('consteval')
    end`;

    if (!content.includes('fmt/core.h')) {
      content = content.replace(/post_install do \|installer\|/, `post_install do |installer|${patch}`);
      fs.writeFileSync(podfile, content);
    }
    return config;
  }]);
};
