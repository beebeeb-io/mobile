// Config plugin for beebeeb-crypto.
//
// Phase 1 (current): registers the module and adds Info.plist keys for background
//   processing (camera/contacts/calendar backup) and permission usage descriptions.
// Phase 2: once repos/core/build-ios.sh produces BeebeebCore.xcframework,
//   this plugin will use withXcodeProject to embed it in the iOS target.

const { withInfoPlist, createRunOncePlugin } = require('@expo/config-plugins')

const withBeebeebCrypto = (config) => {
  config = withInfoPlist(config, (config) => {
    const plist = config.modResults

    // Background modes required for BGProcessingTask (camera backup).
    if (!Array.isArray(plist.UIBackgroundModes)) plist.UIBackgroundModes = []
    if (!plist.UIBackgroundModes.includes('fetch')) plist.UIBackgroundModes.push('fetch')
    if (!plist.UIBackgroundModes.includes('processing')) plist.UIBackgroundModes.push('processing')

    // Register the BGProcessingTask identifiers with the system.
    if (!Array.isArray(plist.BGTaskSchedulerPermittedIdentifiers)) {
      plist.BGTaskSchedulerPermittedIdentifiers = []
    }
    if (!plist.BGTaskSchedulerPermittedIdentifiers.includes('io.beebeeb.app.photo-backup')) {
      plist.BGTaskSchedulerPermittedIdentifiers.push('io.beebeeb.app.photo-backup')
    }
    if (!plist.BGTaskSchedulerPermittedIdentifiers.includes('io.beebeeb.app.native-backup')) {
      plist.BGTaskSchedulerPermittedIdentifiers.push('io.beebeeb.app.native-backup')
    }

    // Permission usage descriptions — only set if not already provided.
    if (!plist.NSPhotoLibraryUsageDescription) {
      plist.NSPhotoLibraryUsageDescription =
        'Beebeeb backs up your photos to your encrypted vault.'
    }
    if (!plist.NSContactsUsageDescription) {
      plist.NSContactsUsageDescription =
        'Beebeeb encrypts and backs up your contacts to your vault.'
    }
    if (!plist.NSCalendarsUsageDescription) {
      plist.NSCalendarsUsageDescription =
        'Beebeeb encrypts and backs up your calendar events to your vault.'
    }
    if (!plist.NSCalendarsFullAccessUsageDescription) {
      plist.NSCalendarsFullAccessUsageDescription =
        'Beebeeb encrypts and backs up your calendar events to your vault.'
    }

    return config
  })

  return config
}

module.exports = createRunOncePlugin(withBeebeebCrypto, 'beebeeb-crypto', '1.0.0')
