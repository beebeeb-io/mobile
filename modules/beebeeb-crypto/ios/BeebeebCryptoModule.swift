import ExpoModulesCore

// Placeholder module. All functions throw NotLinkedError until BeebeebCore.xcframework
// is built (repos/core/build-ios.sh) and linked via the app.plugin.js config plugin.
public class BeebeebCryptoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BeebeebCrypto")

    AsyncFunction("generateRecoveryPhrase") { () throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("recoverFromPhrase") { (_: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("encryptChunk") { (_: Data, _: Data) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("decryptChunk") { (_: Data, _: Data, _: Data) throws -> Data in
      throw NotLinkedError()
    }

    AsyncFunction("encryptMetadata") { (_: Data, _: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("decryptMetadata") { (_: Data, _: Data, _: Data) throws -> String in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueRegistrationStart") { (_: String, _: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueRegistrationFinish") { (_: Data, _: Data) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueLoginStart") { (_: String) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("opaqueLoginFinish") { (_: Data, _: Data) throws -> [String: Any] in
      throw NotLinkedError()
    }

    AsyncFunction("deriveFileKey") { (_: Data, _: String) throws -> Data in
      throw NotLinkedError()
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
  }
}

private struct NotLinkedError: LocalizedError {
  var errorDescription: String? {
    "BeebeebCore.xcframework not linked — run repos/core/build-ios.sh first"
  }
}
