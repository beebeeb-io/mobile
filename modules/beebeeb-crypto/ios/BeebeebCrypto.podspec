require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BeebeebCrypto'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = { :type => 'MIT' }
  s.author         = 'Beebeeb'
  s.homepage       = 'https://beebeeb.io'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.4'
  s.source         = { :git => 'https://github.com/beebeeb-io/mobile.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
  s.vendored_frameworks = '../../../ios/BeebeebCore.xcframework'
  s.exclude_files = [
    'ConstellationFrameProcessor.swift',
    'ConstellationFrameProcessorPlugin.m'
  ]

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'FRAMEWORK_SEARCH_PATHS' => '$(inherited) ${PODS_ROOT}/.. ${PROJECT_DIR}/..',
    'HEADER_SEARCH_PATHS[sdk=iphonesimulator*]' => '$(inherited) "$(PODS_TARGET_SRCROOT)/../../../ios/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers"',
    'HEADER_SEARCH_PATHS[sdk=iphoneos*]' => '$(inherited) "$(PODS_TARGET_SRCROOT)/../../../ios/BeebeebCore.xcframework/ios-arm64/Headers"',
    'OTHER_SWIFT_FLAGS[sdk=iphonesimulator*]' => '$(inherited) -Xcc -fmodule-map-file="$(PODS_TARGET_SRCROOT)/../../../ios/BeebeebCore.xcframework/ios-arm64_x86_64-simulator/Headers/module.modulemap"',
    'OTHER_SWIFT_FLAGS[sdk=iphoneos*]' => '$(inherited) -Xcc -fmodule-map-file="$(PODS_TARGET_SRCROOT)/../../../ios/BeebeebCore.xcframework/ios-arm64/Headers/module.modulemap"'
  }
end
