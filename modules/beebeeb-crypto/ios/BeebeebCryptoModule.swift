import ExpoModulesCore
import Foundation
import FileProvider
import Security

private let fileProviderDomainIdentifier = NSFileProviderDomainIdentifier("io.beebeeb.files")
private let fileProviderDisplayName = "Beebeeb"
private let fileProviderDomainSchemaKey = "io.beebeeb.fileProviderDomainSchema"
private let fileProviderDomainSchemaVersion = "replicated-v2"
private let appGroupIdentifier = "group.io.beebeeb.shared"
private let simulatorFileProviderMasterKeyKey = "io.beebeeb.simulatorFileProviderMasterKey"
private let fileProviderEnabledKey = "io.beebeeb.fileProvider.enabled"
private let fileProviderAuthRequiredKey = "io.beebeeb.fileProvider.requireDeviceAuth"
private let fileProviderUnlockedUntilKey = "io.beebeeb.fileProvider.unlockedUntilMs"
private let fileProviderUnlockWindowSeconds = 300

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

@available(iOS 16.0, *)
private func beebeebFileProviderDomain() -> NSFileProviderDomain {
  NSFileProviderDomain(identifier: fileProviderDomainIdentifier, displayName: fileProviderDisplayName)
}

@available(iOS 16.0, *)
private func getFileProviderDomains() async throws -> [NSFileProviderDomain] {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[NSFileProviderDomain], Error>) in
    NSFileProviderManager.getDomainsWithCompletionHandler { domains, error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: domains)
      }
    }
  }
}

@available(iOS 16.0, *)
private func addFileProviderDomain(_ domain: NSFileProviderDomain) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    NSFileProviderManager.add(domain) { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

@available(iOS 16.0, *)
private func removeFileProviderDomain(_ domain: NSFileProviderDomain) async throws {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
    NSFileProviderManager.remove(domain) { error in
      if let error {
        continuation.resume(throwing: error)
      } else {
        continuation.resume(returning: ())
      }
    }
  }
}

@available(iOS 16.0, *)
private func signalFileProviderEnumerator(
  domain: NSFileProviderDomain,
  itemIdentifier: NSFileProviderItemIdentifier
) async -> String? {
  guard let manager = NSFileProviderManager(for: domain) else {
    return "File Provider manager unavailable"
  }

  return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
    manager.signalEnumerator(for: itemIdentifier) { error in
      continuation.resume(returning: error?.localizedDescription)
    }
  }
}

@available(iOS 16.0, *)
private func fileProviderDomainStatus(
  domain: NSFileProviderDomain,
  registered: Bool,
  added: Bool,
  removedBeforeAdd: Bool = false,
  domainCount: Int,
  rootEnumerationError: String? = nil,
  workingSetEnumerationError: String? = nil
) -> [String: Any] {
  [
    "supported": true,
    "identifier": domain.identifier.rawValue,
    "displayName": domain.displayName,
    "registered": registered,
    "added": added,
    "removedBeforeAdd": removedBeforeAdd,
    "domainCount": domainCount,
    "rootEnumerationSignaled": rootEnumerationError == nil,
    "workingSetEnumerationSignaled": workingSetEnumerationError == nil,
    "rootEnumerationError": rootEnumerationError ?? NSNull(),
    "workingSetEnumerationError": workingSetEnumerationError ?? NSNull(),
  ]
}

private func sharedDefaults() -> UserDefaults? {
  UserDefaults(suiteName: appGroupIdentifier)
}

private func sharedBoolDefaultTrue(_ defaults: UserDefaults?, key: String) -> Bool {
  guard let defaults else { return true }
  if defaults.object(forKey: key) == nil {
    return true
  }
  return defaults.bool(forKey: key)
}

private func clearFileProviderSharedState(defaults: UserDefaults?) -> Int {
  defaults?.set(0, forKey: fileProviderUnlockedUntilKey)

  var removed = 0
  let fileManager = FileManager.default
  if let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier) {
    for name in ["BeebeebFileProvider", "FileProviderCache", "file-provider-cache.sqlite"] {
      let url = container.appendingPathComponent(name)
      if fileManager.fileExists(atPath: url.path) {
        try? fileManager.removeItem(at: url)
        removed += 1
      }
    }
  }
  return removed
}

private func fileProviderPrivacyState(defaults: UserDefaults? = sharedDefaults()) -> [String: Any] {
  let showInFiles = sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
  let requireDeviceAuth = sharedBoolDefaultTrue(defaults, key: fileProviderAuthRequiredKey)
  let unlockedUntilMs = defaults?.double(forKey: fileProviderUnlockedUntilKey) ?? 0
  let locked = requireDeviceAuth && unlockedUntilMs <= Date().timeIntervalSince1970 * 1000

  return [
    "supported": true,
    "showInFiles": showInFiles,
    "requireDeviceAuth": requireDeviceAuth,
    "unlockedUntilMs": unlockedUntilMs,
    "unlockWindowSeconds": fileProviderUnlockWindowSeconds,
    "locked": locked,
  ]
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

    AsyncFunction("replaceKeychainAccessControl") { (require: Bool, masterKeyBytes: Data, label: String) throws -> Bool in
      try KeychainManager.replaceAccessControl(requireBiometric: require, masterKeyBytes: masterKeyBytes, label: label)
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

    AsyncFunction("mirrorSimulatorFileProviderMasterKey") { (masterKeyBase64: String?) -> Bool in
      #if DEBUG && targetEnvironment(simulator)
      guard let defaults = sharedDefaults() else {
        return false
      }
      if let masterKeyBase64, !masterKeyBase64.isEmpty {
        defaults.set(masterKeyBase64, forKey: simulatorFileProviderMasterKeyKey)
      } else {
        defaults.removeObject(forKey: simulatorFileProviderMasterKeyKey)
      }
      defaults.synchronize()
      return true
      #else
      return false
      #endif
    }

    AsyncFunction("registerFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let domain = beebeebFileProviderDomain()
      let domainsBefore = try await getFileProviderDomains()
      let existed = domainsBefore.contains { $0.identifier == domain.identifier }
      let defaults = sharedDefaults()
      guard sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey) else {
        if existed {
          try await removeFileProviderDomain(domain)
        }
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
        let domainsAfter = try await getFileProviderDomains()
        return fileProviderDomainStatus(
          domain: domain,
          registered: false,
          added: false,
          removedBeforeAdd: existed,
          domainCount: domainsAfter.count
        )
      }

      let needsLegacyMigration = existed && defaults?.string(forKey: fileProviderDomainSchemaKey) != fileProviderDomainSchemaVersion
      if needsLegacyMigration {
        try await removeFileProviderDomain(domain)
      }
      if !existed || needsLegacyMigration {
        try await addFileProviderDomain(domain)
      }
      defaults?.set(fileProviderDomainSchemaVersion, forKey: fileProviderDomainSchemaKey)
      defaults?.synchronize()

      let rootError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
      let workingSetError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
      let domainsAfter = try await getFileProviderDomains()

      return fileProviderDomainStatus(
        domain: domain,
        registered: true,
        added: !existed || needsLegacyMigration,
        removedBeforeAdd: needsLegacyMigration,
        domainCount: domainsAfter.count,
        rootEnumerationError: rootError,
        workingSetEnumerationError: workingSetError
      )
    }

    AsyncFunction("listFileProviderDomains") { () async throws -> [[String: Any]] in
      guard #available(iOS 16.0, *) else {
        return []
      }

      let domains = try await getFileProviderDomains()
      return domains.map { domain in
        [
          "identifier": domain.identifier.rawValue,
          "displayName": domain.displayName,
          "isBeebeeb": domain.identifier == fileProviderDomainIdentifier,
        ]
      }
    }

    AsyncFunction("resetFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let domain = beebeebFileProviderDomain()
      let domainsBefore = try await getFileProviderDomains()
      let existed = domainsBefore.contains { $0.identifier == domain.identifier }
      if existed {
        try await removeFileProviderDomain(domain)
      }
      try await addFileProviderDomain(domain)
      let defaults = sharedDefaults()
      defaults?.set(fileProviderDomainSchemaVersion, forKey: fileProviderDomainSchemaKey)
      defaults?.synchronize()

      let rootError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
      let workingSetError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
      let domainsAfter = try await getFileProviderDomains()

      return fileProviderDomainStatus(
        domain: domain,
        registered: true,
        added: true,
        removedBeforeAdd: existed,
        domainCount: domainsAfter.count,
        rootEnumerationError: rootError,
        workingSetEnumerationError: workingSetError
      )
    }

    AsyncFunction("unregisterFileProviderDomain") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let domain = beebeebFileProviderDomain()
      let domainsBefore = try await getFileProviderDomains()
      let existed = domainsBefore.contains { $0.identifier == domain.identifier }
      if existed {
        try await removeFileProviderDomain(domain)
      }
      let defaults = sharedDefaults()
      _ = clearFileProviderSharedState(defaults: defaults)
      defaults?.synchronize()
      let domainsAfter = try await getFileProviderDomains()

      return fileProviderDomainStatus(
        domain: domain,
        registered: false,
        added: false,
        removedBeforeAdd: existed,
        domainCount: domainsAfter.count
      )
    }

    AsyncFunction("setFileProviderEnabled") { (enabled: Bool) async throws -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(enabled, forKey: fileProviderEnabledKey)
      if !enabled {
        _ = clearFileProviderSharedState(defaults: defaults)
      }
      defaults?.synchronize()

      guard #available(iOS 16.0, *) else {
        return [
          "supported": false,
          "identifier": fileProviderDomainIdentifier.rawValue,
          "displayName": fileProviderDisplayName,
          "registered": false,
          "added": false,
          "removedBeforeAdd": false,
          "domainCount": 0,
          "rootEnumerationSignaled": false,
          "workingSetEnumerationSignaled": false,
        ]
      }

      let domain = beebeebFileProviderDomain()
      let domainsBefore = try await getFileProviderDomains()
      let existed = domainsBefore.contains { $0.identifier == domain.identifier }

      if enabled {
        if !existed {
          try await addFileProviderDomain(domain)
        }
        defaults?.set(fileProviderDomainSchemaVersion, forKey: fileProviderDomainSchemaKey)
        defaults?.synchronize()

        let rootError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
        let workingSetError = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
        let domainsAfter = try await getFileProviderDomains()
        return fileProviderDomainStatus(
          domain: domain,
          registered: true,
          added: !existed,
          domainCount: domainsAfter.count,
          rootEnumerationError: rootError,
          workingSetEnumerationError: workingSetError
        )
      }

      if existed {
        try await removeFileProviderDomain(domain)
      }
      let domainsAfter = try await getFileProviderDomains()
      return fileProviderDomainStatus(
        domain: domain,
        registered: false,
        added: false,
        removedBeforeAdd: existed,
        domainCount: domainsAfter.count
      )
    }

    AsyncFunction("getFileProviderPrivacyState") { () -> [String: Any] in
      fileProviderPrivacyState()
    }

    AsyncFunction("setFileProviderAuthRequired") { (required: Bool) -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(required, forKey: fileProviderAuthRequiredKey)
      if required {
        defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      }
      defaults?.synchronize()
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("unlockFileProviderAccess") { () -> [String: Any] in
      let defaults = sharedDefaults()
      let unlockedUntilMs = (Date().timeIntervalSince1970 + Double(fileProviderUnlockWindowSeconds)) * 1000
      defaults?.set(unlockedUntilMs, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("lockFileProviderAccess") { () -> [String: Any] in
      let defaults = sharedDefaults()
      _ = clearFileProviderSharedState(defaults: defaults)
      defaults?.synchronize()
      return fileProviderPrivacyState(defaults: defaults)
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

    AsyncFunction("acknowledgePendingShare") { (id: String) throws -> Bool in
      try PendingSharesAccess.acknowledge(id: id)
    }

    AsyncFunction("clearAllPendingShares") { () throws -> Int in
      try PendingSharesAccess.clearAll()
    }
  }
}
