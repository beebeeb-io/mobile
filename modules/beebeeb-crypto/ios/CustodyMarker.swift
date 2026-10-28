import Foundation

/// Task 2237c, decision L7d: the "a shared-folder custody set was stored on this device" flag.
///
/// It lives OUTSIDE the Keychain so that a Keychain that reads back empty (a restore onto another device,
/// a wiped item) is not mistaken for "no custody was ever seen". One byte, no ids, no plaintext.
///
/// Storage: Application Support, excluded from backup. Not `Caches` (the OS may purge it and the user can
/// clear it), not `Documents` (backed up: a restored marker on a device whose Keychain item did not come
/// along would refuse every custody folder). It is deliberately NOT a `PlaintextStorageProtection` registry
/// entry: that registry is purged at sign-out, and this flag must survive sign-out.
enum CustodyMarker {
  private static let fileName = "beebeeb-custody-marker"

  private static var url: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent(fileName, isDirectory: false)
  }

  static func exists() -> Bool {
    guard let url else { return false }
    return FileManager.default.fileExists(atPath: url.path)
  }

  static func write() throws {
    guard var url else { throw CocoaError(.fileNoSuchFile) }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data([0x31]).write(to: url, options: .atomic)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }
}
