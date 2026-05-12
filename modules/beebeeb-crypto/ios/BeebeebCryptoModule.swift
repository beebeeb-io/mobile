import ExpoModulesCore
import Foundation
import Security

private func decodeBase64(_ value: String, field: String) throws -> Data {
  guard let data = Data(base64Encoded: value) else {
    throw NSError(
      domain: "BeebeebCrypto",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Invalid base64 for \(field)"]
    )
  }
  return data
}

// All crypto runs through `BeebeebCryptoBridge`, which wraps the UniFFI
// bindings shipped in `BeebeebCore.xcframework` (linked via the
// `withUniffiBridge` config plugin).
public class BeebeebCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("generateRandomBytes") { (length: Int) throws -> Data in
      guard length > 0, length <= 4096 else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Invalid random byte length"]
        )
      }

      var bytes = [UInt8](repeating: 0, count: length)
      let status = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
      guard status == errSecSuccess else {
        throw NSError(
          domain: "BeebeebCrypto",
          code: Int(status),
          userInfo: [NSLocalizedDescriptionKey: "Secure random generator failed"]
        )
      }
      return Data(bytes)
    }

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

    AsyncFunction("computeRecoveryCheck") { (masterKey: Data) throws -> Data in
      try computeRecoveryCheck(masterKey: masterKey)
    }

    AsyncFunction("deriveX25519Private") { (masterKey: Data) throws -> Data in
      try deriveX25519Private(masterKey: masterKey)
    }

    AsyncFunction("deriveX25519Public") { (privateKey: Data) throws -> Data in
      try deriveX25519Public(privateKey: privateKey)
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
        "state": result.state.base64EncodedString(),
        "message": result.message.base64EncodedString(),
      ]
    }

    AsyncFunction("opaqueRegistrationFinish") { (state: String, serverMessage: String, password: String) throws -> [String: Any] in
      let stateData = try decodeBase64(state, field: "state")
      let serverMessageData = try decodeBase64(serverMessage, field: "serverMessage")
      let record = try opaqueRegistrationFinish(clientState: stateData, password: Data(password.utf8), serverResponse: serverMessageData)
      return ["record": record.base64EncodedString()]
    }

    AsyncFunction("opaqueLoginStart") { (username: String, password: String) throws -> [String: Any] in
      let result = try opaqueLoginStart(password: Data(password.utf8))
      return [
        "state": result.state.base64EncodedString(),
        "message": result.message.base64EncodedString(),
      ]
    }

    AsyncFunction("opaqueLoginFinish") { (state: String, serverMessage: String, password: String) throws -> [String: Any] in
      let stateData = try decodeBase64(state, field: "state")
      let serverMessageData = try decodeBase64(serverMessage, field: "serverMessage")
      let result = try opaqueLoginFinish(clientState: stateData, password: Data(password.utf8), serverResponse: serverMessageData)
      return [
        "message": result.message.base64EncodedString(),
        "sessionKey": result.sessionKey.base64EncodedString(),
        "exportKey": result.exportKey.base64EncodedString(),
      ]
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

    AsyncFunction("mirrorSessionToAppGroup") { (token: String?, baseUrl: String?) -> Bool in
      guard let defaults = UserDefaults(suiteName: "group.io.beebeeb.shared") else {
        return false
      }
      if let token, !token.isEmpty {
        defaults.set(token, forKey: "io.beebeeb.sessionToken")
        UserDefaults.standard.set(token, forKey: "io.beebeeb.backupToken")
      } else {
        defaults.removeObject(forKey: "io.beebeeb.sessionToken")
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.backupToken")
      }
      if let baseUrl, !baseUrl.isEmpty {
        defaults.set(baseUrl, forKey: "io.beebeeb.apiBaseUrl")
        UserDefaults.standard.set(baseUrl, forKey: "io.beebeeb.serverURL")
      }
      defaults.synchronize()
      UserDefaults.standard.synchronize()
      return true
    }

    // ── Backup management ──────────────────────────────────────────────

    AsyncFunction("configureBackupFolder") { (category: String, parentFolderId: String?) in
      switch category {
      case "camera_roll":
        PhotoBackupManager.shared.configure(parentFolderId: parentFolderId)
      case "contacts":
        ContactsBackupManager.shared.configure(parentFolderId: parentFolderId)
      case "calendar":
        CalendarBackupManager.shared.configure(parentFolderId: parentFolderId)
      default:
        break
      }
    }

    AsyncFunction("enablePhotoBackup") { (authToken: String) in
      PhotoBackupManager.shared.enable(authToken: authToken)
    }

    AsyncFunction("disablePhotoBackup") { () in
      PhotoBackupManager.shared.disable()
    }

    AsyncFunction("enableContactsBackup") { (authToken: String) in
      ContactsBackupManager.shared.enable(authToken: authToken, runNow: true)
    }

    AsyncFunction("resumeContactsBackup") { (authToken: String) in
      ContactsBackupManager.shared.enable(authToken: authToken, runNow: false)
    }

    AsyncFunction("disableContactsBackup") { () in
      ContactsBackupManager.shared.disable()
    }

    AsyncFunction("enableCalendarBackup") { (authToken: String) in
      CalendarBackupManager.shared.enable(authToken: authToken, runNow: true)
    }

    AsyncFunction("resumeCalendarBackup") { (authToken: String) in
      CalendarBackupManager.shared.enable(authToken: authToken, runNow: false)
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
