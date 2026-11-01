import Foundation

/// Task SF-0001 (contract 2275 L13, mobile#259 review M1): the order of one
/// Contacts/Calendar backup create (`NativeEncryptedBackupUploader`), with the
/// network and the chunk encryption injected so the harness drives it
/// (`scripts/swift-tests/backup-create-upload-flow-test.swift`).
///
/// The uploader mints `fileId` and seals the name and every chunk under it. It
/// is the ONLY id anything is PUT, completed or reported under:
/// - the init answer must echo it before the first chunk is encrypted or PUT;
///   on a mismatch the session for the REQUESTED id is abandoned and nothing
///   else is sent;
/// - the completion answer must echo it before the caller records success.
///
/// Before, the uploader took the init answer's `file_id` as the destination of
/// the chunk PUTs and the complete without comparing it: a different id stored
/// the vCard/ICS where no reader could open it, and `recordUploadSuccess` then
/// stopped the retries (a silent loss of the backup).
struct BackupCreateUploadFlow {
  let fileId: String
  let chunkCount: Int
  /// `POST /files/upload/init` (proposing `fileId`); the parsed answer.
  let initUpload: () throws -> [String: Any]
  /// Encrypt chunk `index` and PUT it under `destination` (always `fileId`).
  let putChunk: (_ index: Int, _ destination: String) throws -> Void
  /// The encryptor's integrity guard and the account re-check, before the
  /// one irreversible step.
  let beforeComplete: () throws -> Void
  /// `POST /files/{destination}/upload/complete`; the parsed answer, if any.
  let complete: (_ destination: String) throws -> [String: Any]?
  /// Best-effort abandon of the requested id's session.
  let abandon: (_ requested: String) -> Void

  /// The id the upload landed under (always `fileId`).
  func run() throws -> String {
    let answer = try initUpload()
    do {
      try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: answer["file_id"] as? String)
    } catch {
      abandon(fileId)
      throw error
    }
    for index in 0..<chunkCount {
      try putChunk(index, fileId)
    }
    try beforeComplete()
    let completed = try complete(fileId)
    try UploadItemIdEcho.assertEchoedId(chosen: fileId, echoed: completed?["id"] as? String, stage: .completion)
    return fileId
  }
}
