import Foundation

/// Task SF-0001 (contract 2275 L13): this client mints the item id it proposes
/// on a create and compares it with the id every init/create/completion answer
/// echoes back. A difference aborts BEFORE anything is sealed, renamed,
/// published or used as a destination — this device's bytes only ever live
/// under an id it chose itself.
///
/// `targets/file-provider/FileProviderExtension.swift` and
/// `targets/share-extension/ShareUploader.swift` carry the same checks in
/// their own targets (the extensions do not link this pod), so the sentence
/// and the rule live next to the code that enforces them in each binary.
enum UploadItemIdEcho {
  /// The plain sentence shown to the user; never a machine code.
  static let message = "The server answered with a different item. Nothing was uploaded under it."

  /// The typed code callers/tests assert on.
  static let errorCode = "server_changed_item_id"

  /// Thrown when an answer names a different item than the one proposed.
  struct Mismatch: Error, Equatable {
    let code = UploadItemIdEcho.errorCode
    var localizedDescription: String { UploadItemIdEcho.message }
  }

  /// Aborts unless `echoed` is exactly the id `chosen` (this client's own).
  static func assertEchoedId(chosen: String, echoed: String?) throws {
    guard let echoed, echoed == chosen else { throw Mismatch() }
  }
}
