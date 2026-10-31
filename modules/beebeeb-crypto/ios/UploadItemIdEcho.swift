import Foundation

/// Task SF-0001 (contract 2275 L13): this client mints the item id it proposes
/// on a create and compares it with the id every init/create/completion answer
/// echoes back. A difference aborts BEFORE anything is sealed, renamed,
/// published or used as a destination — this device's bytes only ever live
/// under an id it chose itself.
///
/// `targets/file-provider/FileProviderExtension.swift` and
/// `targets/share-extension/ShareUploader.swift` carry the same enum in their
/// own targets (the extensions do not link this pod). Its body is copied there
/// VERBATIM (`src/lib/sf-0001-r2-wiring.test.ts` (M11) fails on any drift),
/// so the Swift test of this file covers all three.
enum UploadItemIdEcho {
  /// The plain sentence shown when the init or create answer names another item.
  static let message = "The server answered with a different item. Nothing was uploaded under it."
  /// After a completion "nothing was uploaded" is not true: the bytes went up
  /// under our id, but the answer named another item, so this client does not
  /// count it as uploaded (mobile#259 review M6).
  static let completionMessage = "The server finished this upload under a different item. Beebeeb did not count it as uploaded."
  /// The typed code callers and tests assert on.
  static let errorCode = "server_changed_item_id"

  enum Stage: Equatable {
    case create
    case completion
  }

  /// A `LocalizedError`: `localizedDescription` on an `Error` existential
  /// reaches `errorDescription`, never a plain property (mobile#259 review M4).
  struct Mismatch: LocalizedError, Equatable {
    let code = UploadItemIdEcho.errorCode
    let stage: Stage

    init(stage: Stage = .create) {
      self.stage = stage
    }

    var errorDescription: String? {
      stage == .completion ? UploadItemIdEcho.completionMessage : UploadItemIdEcho.message
    }
  }

  /// Aborts unless `echoed` is exactly the id `chosen` (this client's own).
  static func assertEchoedId(chosen: String, echoed: String?, stage: Stage = .create) throws {
    guard let echoed, echoed == chosen else { throw Mismatch(stage: stage) }
  }
}
