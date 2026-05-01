import ExpoModulesCore
import Foundation

// All crypto runs through `BeebeebCryptoBridge`, which wraps the UniFFI
// bindings shipped in `BeebeebCore.xcframework` (linked via the
// `withUniffiBridge` config plugin).
public class BeebeebCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("generateRecoveryPhrase") { () throws -> [String: Any] in
      let result = try generateRecoveryPhrase()
      return [
        "phrase": result.phrase,
        "masterKey": result.masterKey,
      ]
    }

    AsyncFunction("recoverFromPhrase") { (phrase: String) throws -> [String: Any] in
      let masterKey = try recoverFromPhrase(phrase: phrase)
      return ["masterKey": masterKey]
    }

    AsyncFunction("encryptChunk") { (key: Data, plaintext: Data) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptChunk(key: key, plaintext: plaintext)
      return [
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptChunk") { (key: Data, nonce: Data, ciphertext: Data) throws -> Data in
      try BeebeebCryptoBridge.decryptChunk(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("encryptMetadata") { (key: Data, metadata: String) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptMetadata(key: key, metadata: metadata)
      return [
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptMetadata") { (key: Data, nonce: Data, ciphertext: Data) throws -> String in
      try BeebeebCryptoBridge.decryptMetadata(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("opaqueRegistrationStart") { (_ username: String, password: String) throws -> [String: Any] in
      let result = try opaqueRegistrationStart(password: Data(password.utf8))
      return [
        "state": result.state,
        "message": result.message,
      ]
    }

    AsyncFunction("opaqueRegistrationFinish") { (state: Data, serverMessage: Data) throws -> [String: Any] in
      // The current JS contract drops the password between start/finish; the UniFFI
      // surface still requires it. Plumbing the password through the JS layer is
      // tracked separately.
      throw OpaquePasswordMissingError()
    }

    AsyncFunction("opaqueLoginStart") { (username: String) throws -> [String: Any] in
      let result = try opaqueLoginStart(password: Data(username.utf8))
      return [
        "state": result.state,
        "message": result.message,
      ]
    }

    AsyncFunction("opaqueLoginFinish") { (state: Data, serverMessage: Data) throws -> [String: Any] in
      throw OpaquePasswordMissingError()
    }

    AsyncFunction("deriveFileKey") { (masterKey: Data, fileId: String) throws -> Data in
      try BeebeebCryptoBridge.deriveFileKey(masterKey: masterKey, fileId: fileId)
    }

    AsyncFunction("storeKeyInKeychain") { (masterKeyBytes: Data, label: String) throws in
      try KeychainManager.store(masterKeyBytes: masterKeyBytes, label: label)
    }

    AsyncFunction("loadKeyFromKeychain") { (label: String) throws -> Data? in
      try KeychainManager.load(label: label)
    }

    AsyncFunction("deleteKeyFromKeychain") { () throws -> Bool in
      KeychainManager.delete()
      return true
    }

    AsyncFunction("setRequireBiometric") { (require: Bool) throws -> Bool in
      try KeychainManager.setAccessControl(requireBiometric: require)
      return true
    }

    // ── Backup management ──────────────────────────────────────────────

    AsyncFunction("enablePhotoBackup") { (authToken: String) in
      PhotoBackupManager.shared.enable(authToken: authToken)
    }

    AsyncFunction("disablePhotoBackup") { () in
      PhotoBackupManager.shared.disable()
    }

    AsyncFunction("enableContactsBackup") { (authToken: String) in
      ContactsBackupManager.shared.enable(authToken: authToken)
    }

    AsyncFunction("disableContactsBackup") { () in
      ContactsBackupManager.shared.disable()
    }

    AsyncFunction("enableCalendarBackup") { (authToken: String) in
      CalendarBackupManager.shared.enable(authToken: authToken)
    }

    AsyncFunction("disableCalendarBackup") { () in
      CalendarBackupManager.shared.disable()
    }

    AsyncFunction("getBackupProgress") { () -> [String: Any] in
      let p = PhotoBackupManager.shared.getProgress()
      return [
        "total": p.total,
        "completed": p.completed,
        "inProgress": p.inProgress,
        "lastBackupAt": p.lastBackupAt as Any,
      ]
    }

    AsyncFunction("triggerImmediateBackup") { (authToken: String) in
      PhotoBackupManager.shared.enable(authToken: authToken)
      PhotoBackupManager.shared.triggerImmediateBatch { _ in }
      ContactsBackupManager.shared.enable(authToken: authToken)
      CalendarBackupManager.shared.enable(authToken: authToken)
    }

    // ── Share Extension: pending shares dropped by BeebeebShare ────────
    //
    // The iOS Share Extension writes files into the App Group container at
    // group.io.beebeeb.shared/IncomingShares/. The main app picks them up
    // here, copies each into its own sandbox so the JS side can fetch a
    // file:// URI, and removes the App Group copy on `consume`.

    AsyncFunction("listPendingShares") { () throws -> [[String: Any]] in
      try PendingSharesAccess.list()
    }

    AsyncFunction("consumePendingShare") { (id: String) throws -> [String: Any] in
      try PendingSharesAccess.consume(id: id)
    }

    AsyncFunction("clearAllPendingShares") { () throws -> Int in
      try PendingSharesAccess.clearAll()
    }
  }
}

private struct OpaquePasswordMissingError: LocalizedError {
  var errorDescription: String? {
    "OPAQUE finish requires the password — JS-side signature needs to be updated to forward it."
  }
}
