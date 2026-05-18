import ExpoModulesCore
import Foundation
import FileProvider
import PDFKit
import Security
import SQLite3
import UIKit
import UserNotifications

private let fileProviderDomainIdentifier = NSFileProviderDomainIdentifier("io.beebeeb.files")
private let fileProviderDisplayName = "Beebeeb"
private let fileProviderDomainSchemaKey = "io.beebeeb.fileProviderDomainSchema"
private let fileProviderDomainSchemaVersion = "replicated-v3"
private let appGroupIdentifier = "group.io.beebeeb.shared"
private let simulatorFileProviderMasterKeyKey = "io.beebeeb.simulatorFileProviderMasterKey"
private let sharedSessionTokenKey = "io.beebeeb.sessionToken"
private let sharedAPIBaseURLKey = "io.beebeeb.apiBaseUrl"
private let fileProviderEnabledKey = "io.beebeeb.fileProvider.enabled"
private let fileProviderTrustedMountKey = "io.beebeeb.fileProvider.trustedMountEnabled"
private let fileProviderAuthRequiredKey = "io.beebeeb.fileProvider.requireDeviceAuth"
private let fileProviderUnlockedUntilKey = "io.beebeeb.fileProvider.unlockedUntilMs"
private let fileProviderEnumeratorStatePrefix = "io.beebeeb.fileProvider.enumerator."

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

private func fileURL(fromURI uri: String) -> URL {
  if let url = URL(string: uri), url.isFileURL {
    return url
  }
  return URL(fileURLWithPath: uri)
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
private func signalBeebeebFileProviderEnumerators() async {
  let domain = beebeebFileProviderDomain()
  let domains = (try? await getFileProviderDomains()) ?? []
  guard domains.contains(where: { $0.identifier == domain.identifier }) else {
    return
  }

  _ = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .rootContainer)
  _ = await signalFileProviderEnumerator(domain: domain, itemIdentifier: .workingSet)
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
  defaults?.set(false, forKey: fileProviderEnabledKey)
  defaults?.set(false, forKey: fileProviderTrustedMountKey)
  defaults?.set(true, forKey: fileProviderAuthRequiredKey)
  defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
  defaults?.removeObject(forKey: sharedSessionTokenKey)
  defaults?.removeObject(forKey: sharedAPIBaseURLKey)
  defaults?.removeObject(forKey: simulatorFileProviderMasterKeyKey)
  let removed = clearFileProviderCacheState(defaults: defaults)
  return removed
}

private func clearFileProviderCacheState(defaults: UserDefaults?) -> Int {
  defaults?.dictionaryRepresentation().keys
    .filter { $0.hasPrefix(fileProviderEnumeratorStatePrefix) }
    .forEach { defaults?.removeObject(forKey: $0) }

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
  let trustedMountEnabled = defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false
  let showInFiles = trustedMountEnabled && sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
  let requireDeviceAuth = true
  let unlockedUntilMs = defaults?.double(forKey: fileProviderUnlockedUntilKey) ?? 0
  let locked = !showInFiles

  return [
    "supported": true,
    "showInFiles": showInFiles,
    "trustedMountEnabled": trustedMountEnabled,
    "mounted": showInFiles,
    "requireDeviceAuth": requireDeviceAuth,
    "unlockedUntilMs": unlockedUntilMs,
    "unlockWindowSeconds": 0,
    "locked": locked,
  ]
}

@available(iOS 16.0, *)
private func registerMountedFileProviderDomain(defaults: UserDefaults?) async throws -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domainsBefore = try await getFileProviderDomains()
  let existed = domainsBefore.contains { $0.identifier == domain.identifier }
  let needsLegacyMigration = existed && defaults?.string(forKey: fileProviderDomainSchemaKey) != fileProviderDomainSchemaVersion

  if needsLegacyMigration {
    try await removeFileProviderDomain(domain)
    _ = clearFileProviderCacheState(defaults: defaults)
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

@available(iOS 16.0, *)
private func removeMountedFileProviderDomain(defaults: UserDefaults?) async throws -> [String: Any] {
  let domain = beebeebFileProviderDomain()
  let domainsBefore = try await getFileProviderDomains()
  let existed = domainsBefore.contains { $0.identifier == domain.identifier }
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

    AsyncFunction("x25519SharedSecret") { (myPrivate: Data, theirPublic: Data) throws -> Data in
      try x25519SharedSecret(myPrivate: myPrivate, theirPublic: theirPublic)
    }

    AsyncFunction("deriveShareKey") { (sharedSecret: Data, fileId: Data) throws -> Data in
      try deriveShareKey(sharedSecret: sharedSecret, fileId: fileId)
    }

    AsyncFunction("encryptChunk") { (key: Data, plaintext: Data) throws -> [String: Any] in
      let result = try BeebeebCryptoBridge.encryptChunk(key: key, plaintext: plaintext)
      return [
        "cipherSuite": result.cipherSuite,
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
        "cipherSuite": result.cipherSuite,
        "nonce": result.nonce,
        "ciphertext": result.ciphertext,
      ]
    }

    AsyncFunction("decryptMetadata") { (key: Data, nonce: Data, ciphertext: Data) throws -> String in
      try BeebeebCryptoBridge.decryptMetadata(key: key, nonce: nonce, ciphertext: ciphertext)
    }

    AsyncFunction("renderPdfFirstPage") { (inputUri: String, outputUri: String, maxDimension: Double) throws -> String? in
      let inputURL = fileURL(fromURI: inputUri)
      let outputURL = fileURL(fromURI: outputUri)

      guard let document = PDFDocument(url: inputURL), let page = document.page(at: 0) else {
        return nil
      }

      let pageBounds = page.bounds(for: .mediaBox)
      guard pageBounds.width > 0, pageBounds.height > 0 else {
        return nil
      }

      let safeMaxDimension = max(320, min(maxDimension, 2400))
      let scale = min(safeMaxDimension / pageBounds.width, safeMaxDimension / pageBounds.height)
      let outputSize = CGSize(width: pageBounds.width * scale, height: pageBounds.height * scale)

      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      let renderer = UIGraphicsImageRenderer(size: outputSize, format: format)
      let image = renderer.image { context in
        UIColor.white.setFill()
        context.fill(CGRect(origin: .zero, size: outputSize))
        context.cgContext.saveGState()
        context.cgContext.translateBy(x: 0, y: outputSize.height)
        context.cgContext.scaleBy(x: scale, y: -scale)
        context.cgContext.translateBy(x: -pageBounds.origin.x, y: -pageBounds.origin.y)
        page.draw(with: .mediaBox, to: context.cgContext)
        context.cgContext.restoreGState()
      }

      guard let data = image.pngData() else {
        return nil
      }

      try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      try data.write(to: outputURL, options: .atomic)
      return outputURL.absoluteString
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
        defaults.set(token, forKey: sharedSessionTokenKey)
        UserDefaults.standard.set(token, forKey: "io.beebeeb.backupToken")
      } else {
        defaults.removeObject(forKey: sharedSessionTokenKey)
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.backupToken")
      }
      if let baseUrl, !baseUrl.isEmpty {
        defaults.set(baseUrl, forKey: sharedAPIBaseURLKey)
        UserDefaults.standard.set(baseUrl, forKey: "io.beebeeb.serverURL")
      } else {
        defaults.removeObject(forKey: sharedAPIBaseURLKey)
      }
      defaults.synchronize()
      UserDefaults.standard.synchronize()
      return true
    }

    AsyncFunction("mirrorSimulatorFileProviderMasterKey") { (masterKeyBase64: String?) -> Bool in
      guard let defaults = sharedDefaults() else {
        return false
      }
      _ = masterKeyBase64
      defaults.removeObject(forKey: simulatorFileProviderMasterKeyKey)
      defaults.synchronize()
      return false
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

      let defaults = sharedDefaults()
      guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false),
            sharedBoolDefaultTrue(defaults, key: fileProviderEnabledKey)
      else {
        return try await removeMountedFileProviderDomain(defaults: defaults)
      }

      return try await registerMountedFileProviderDomain(defaults: defaults)
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
      _ = clearFileProviderCacheState(defaults: sharedDefaults())
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

      let defaults = sharedDefaults()
      return try await removeMountedFileProviderDomain(defaults: defaults)
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

      if enabled {
        guard (defaults?.bool(forKey: fileProviderTrustedMountKey) ?? false) else {
          return try await removeMountedFileProviderDomain(defaults: defaults)
        }
        return try await registerMountedFileProviderDomain(defaults: defaults)
      }

      return try await removeMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("mountFileProviderAccess") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        let defaults = sharedDefaults()
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
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

      let defaults = sharedDefaults()
      defaults?.set(true, forKey: fileProviderEnabledKey)
      defaults?.set(true, forKey: fileProviderTrustedMountKey)
      defaults?.set(true, forKey: fileProviderAuthRequiredKey)
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()

      return try await registerMountedFileProviderDomain(defaults: defaults)
    }

    AsyncFunction("removeFileProviderAccess") { () async throws -> [String: Any] in
      guard #available(iOS 16.0, *) else {
        let defaults = sharedDefaults()
        _ = clearFileProviderSharedState(defaults: defaults)
        defaults?.synchronize()
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

      return try await removeMountedFileProviderDomain(defaults: sharedDefaults())
    }

    AsyncFunction("getFileProviderPrivacyState") { () -> [String: Any] in
      fileProviderPrivacyState()
    }

    AsyncFunction("setFileProviderAuthRequired") { (_: Bool) async -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(true, forKey: fileProviderAuthRequiredKey)
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("unlockFileProviderAccess") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      defaults?.set(0, forKey: fileProviderUnlockedUntilKey)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    AsyncFunction("lockFileProviderAccess") { () async -> [String: Any] in
      let defaults = sharedDefaults()
      _ = clearFileProviderSharedState(defaults: defaults)
      defaults?.synchronize()
      if #available(iOS 16.0, *) {
        await signalBeebeebFileProviderEnumerators()
      }
      return fileProviderPrivacyState(defaults: defaults)
    }

    // ── File Provider cache pre-population ──────────────────────────────
    //
    // The File Provider extension cannot decrypt filenames when BeebeebCore
    // xcframework is not linked to the extension target. As a workaround the
    // main app decrypts names on the JS side and writes them to the shared
    // SQLite cache here.

    AsyncFunction("syncFileProviderCache") { (entries: [[String: Any]]) -> Int in
      guard let containerUrl = FileManager.default.containerURL(
        forSecurityApplicationGroupIdentifier: appGroupIdentifier
      ) else {
        return 0
      }
      let dbPath = containerUrl.appendingPathComponent("file-provider-cache.sqlite").path
      var db: OpaquePointer?
      guard sqlite3_open_v2(
        dbPath,
        &db,
        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
        nil
      ) == SQLITE_OK, let db else {
        sqlite3_close(db)
        return 0
      }
      defer { sqlite3_close(db) }

      // Ensure the table exists (idempotent)
      let createSql = """
      CREATE TABLE IF NOT EXISTS file_cache (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name_encrypted TEXT,
        name_decrypted TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        is_folder INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        has_thumbnail INTEGER NOT NULL DEFAULT 0,
        thumbnail_data BLOB,
        thumbnail_nonce BLOB,
        created_at TEXT,
        updated_at TEXT,
        sync_anchor INTEGER NOT NULL DEFAULT 0,
        is_materialized INTEGER NOT NULL DEFAULT 0
      );
      """
      sqlite3_exec(db, createSql, nil, nil, nil)

      let upsertSql = """
      INSERT INTO file_cache(
        id, parent_id, name_encrypted, name_decrypted, mime_type, size_bytes,
        is_folder, is_pinned, has_thumbnail, created_at, updated_at, sync_anchor, is_materialized
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        name_encrypted = excluded.name_encrypted,
        name_decrypted = COALESCE(excluded.name_decrypted, file_cache.name_decrypted),
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        is_folder = excluded.is_folder,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        sync_anchor = excluded.sync_anchor;
      """

      sqlite3_exec(db, "BEGIN", nil, nil, nil)
      var count = 0
      let now = Int64(Date().timeIntervalSince1970 * 1000)
      let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

      for entry in entries {
        guard let id = entry["id"] as? String else { continue }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, upsertSql, -1, &stmt, nil) == SQLITE_OK else { continue }
        defer { sqlite3_finalize(stmt) }

        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, transient)
        if let parentId = entry["parent_id"] as? String {
          sqlite3_bind_text(stmt, 2, (parentId as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 2) }
        if let nameEnc = entry["name_encrypted"] as? String {
          sqlite3_bind_text(stmt, 3, (nameEnc as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 3) }
        if let nameDec = entry["name_decrypted"] as? String, !nameDec.isEmpty {
          sqlite3_bind_text(stmt, 4, (nameDec as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 4) }
        if let mime = entry["mime_type"] as? String {
          sqlite3_bind_text(stmt, 5, (mime as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 5) }
        sqlite3_bind_int64(stmt, 6, Int64(entry["size_bytes"] as? Int ?? 0))
        sqlite3_bind_int(stmt, 7, (entry["is_folder"] as? Bool ?? false) ? 1 : 0)
        if let createdAt = entry["created_at"] as? String {
          sqlite3_bind_text(stmt, 8, (createdAt as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 8) }
        if let updatedAt = entry["updated_at"] as? String {
          sqlite3_bind_text(stmt, 9, (updatedAt as NSString).utf8String, -1, transient)
        } else { sqlite3_bind_null(stmt, 9) }
        sqlite3_bind_int64(stmt, 10, now)

        if sqlite3_step(stmt) == SQLITE_DONE { count += 1 }
      }
      sqlite3_exec(db, "COMMIT", nil, nil, nil)

      // Signal the File Provider to re-enumerate so it picks up fresh names.
      if #available(iOS 16.0, *), count > 0 {
        let domain = beebeebFileProviderDomain()
        NSFileProviderManager(for: domain)?.signalEnumerator(for: .workingSet) { _ in }
      }

      return count
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
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      if engine.apiBaseUrl == nil {
        engine.apiBaseUrl = UserDefaults.standard.string(forKey: "io.beebeeb.serverURL")
      }
      engine.start()
    }

    AsyncFunction("disablePhotoBackup") { () in
      NativeBackupEngine.shared.stop()
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
      return NativeBackupEngine.shared.currentProgress()
    }

    AsyncFunction("triggerImmediateBackup") { (authToken: String) in
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      if engine.apiBaseUrl == nil {
        engine.apiBaseUrl = UserDefaults.standard.string(forKey: "io.beebeeb.serverURL")
      }
      // start() is idempotent — returns immediately if already running.
      engine.start()
      Task {
        _ = try? await engine.processBatch(limit: 50)
      }
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

    // ── Backup progress notification ─────────────────────────────────────

    AsyncFunction("updateBackupNotification") { (uploaded: Int, total: Int, throughputMBps: Double, isComplete: Bool) in
      let content = UNMutableNotificationContent()
      content.title = "Beebeeb Backup"
      if isComplete {
        content.body = "\(total) photos secured"
      } else {
        let speed = String(format: "%.1f MB/s", throughputMBps)
        content.body = "Backing up \(uploaded) of \(total) photos \u{00B7} \(speed)"
      }
      content.sound = nil

      let request = UNNotificationRequest(
        identifier: "io.beebeeb.backup-progress",
        content: content,
        trigger: nil
      )
      try? await UNUserNotificationCenter.current().add(request)

      if isComplete {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
          UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: ["io.beebeeb.backup-progress"]
          )
        }
      }
    }

    AsyncFunction("clearBackupNotification") { () in
      UNUserNotificationCenter.current().removeDeliveredNotifications(
        withIdentifiers: ["io.beebeeb.backup-progress"]
      )
    }

    // ── Native Backup Engine ──────────────────────────────────────────────

    AsyncFunction("startNativeBackup") { (authToken: String, apiBaseUrl: String, parentFolderId: String?) in
      let engine = NativeBackupEngine.shared
      engine.token = authToken
      engine.apiBaseUrl = apiBaseUrl
      engine.parentFolderId = parentFolderId
      engine.start()
    }

    AsyncFunction("stopNativeBackup") { () in
      NativeBackupEngine.shared.stop()
    }

    AsyncFunction("pauseNativeBackup") { () in
      NativeBackupEngine.shared.pause()
    }

    AsyncFunction("resumeNativeBackup") { () in
      NativeBackupEngine.shared.resume()
    }

    AsyncFunction("getNativeBackupProgress") { () -> [String: Any] in
      return NativeBackupEngine.shared.currentProgress()
    }

    AsyncFunction("triggerNativeBackupBatch") { () async throws -> [String: Any] in
      let uploaded = try await NativeBackupEngine.shared.processBatch(limit: 30)
      return NativeBackupEngine.shared.currentProgress().merging(
        ["batchUploaded": uploaded],
        uniquingKeysWith: { _, new in new }
      )
    }
  }
}
