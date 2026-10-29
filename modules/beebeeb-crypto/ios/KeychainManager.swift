import Foundation
import LocalAuthentication
import Security

enum KeychainError: LocalizedError {
  case seKeyGenerationFailed
  case seKeyNotFound
  case encryptionFailed
  case decryptionFailed
  case writeError(OSStatus)
  case readError(OSStatus)
  case invalidMasterKeySize
  /// Typed biometric/passcode outcome for the primary master-key load, carried
  /// to the JS layer as a stable code so cold-start warm-up (retry) is
  /// distinguished from a real cancel / auth failure / lockout (surface, stay
  /// locked — task 0882 / fail-closed 0428).
  case vaultAuth(BeebeebKeychainCore.AuthFailureReason)

  var errorDescription: String? {
    switch self {
    case .seKeyGenerationFailed: return "Failed to generate Secure Enclave key"
    case .seKeyNotFound: return "Secure Enclave wrapping key not found"
    case .encryptionFailed: return "ECIES encryption failed"
    case .decryptionFailed: return "ECIES decryption failed — biometric or passcode required"
    case .writeError(let s): return "Keychain write error \(s)"
    case .readError(let s): return "Keychain read error \(s)"
    case .invalidMasterKeySize: return "Master key must be exactly 32 bytes"
    case .vaultAuth(let reason): return reason.message
    }
  }
}

/// Two-tier Secure Enclave key hierarchy for the Beebeeb master key.
///
/// Tier 1 — SE wrapping key: P-256 EC key stored in the Secure Enclave. Never exported.
/// Tier 2 — Wrapped master key: AES-256 master key encrypted by the SE public key (ECIES),
///           stored as kSecClassGenericPassword with kSecAttrAccessibleAfterFirstUnlock.
///
/// This allows background camera/contact backup to run after the first device unlock without
/// re-prompting biometrics, while still keeping the master key protected by hardware.
///
/// **Read logic is shared via `BeebeebKeychainCore`** (task 0436). This type
/// keeps the write paths (`store`, `setAccessControl`, etc.), the access-control
/// policy flag, the simulator-software-key path, and the string-storage
/// helpers added in 0430. Constants live in `BeebeebKeychainCore` and are
/// referenced through it rather than redeclared here.
final class KeychainManager {

  // MARK: - Constants
  //
  // The SE key tags, services, access group, and ECIES algorithm all live on
  // `BeebeebKeychainCore` — single source of truth across the main app and
  // both extensions. Local constants here are only for paths that have no
  // counterpart in extensions.

  #if DEBUG && targetEnvironment(simulator)
  private static let simulatorSoftwareKeyService = "io.beebeeb.masterkey.simulator-software"
  #endif

  // Persisted across launches in UserDefaults (not sensitive — it's just a policy flag).
  private static var requiresBiometric: Bool {
    get { UserDefaults.standard.bool(forKey: "io.beebeeb.requiresBiometric") }
    set { UserDefaults.standard.set(newValue, forKey: "io.beebeeb.requiresBiometric") }
  }

  // MARK: - Store

  /// Encrypt `masterKeyBytes` with the SE wrapping key and persist in Keychain.
  /// Generates the SE wrapping key on first call.
  static func store(masterKeyBytes: Data, label: String) throws {
    guard masterKeyBytes.count == 32 else {
      throw KeychainError.invalidMasterKeySize
    }

    #if DEBUG && targetEnvironment(simulator)
    try storeSimulatorSoftwareKey(masterKeyBytes: masterKeyBytes, label: label)
    #else
    // --- Primary SE key (biometric or passcode, per user preference) ---
    let seKey = try getOrCreateSEKey()
    guard let publicKey = SecKeyCopyPublicKey(seKey) else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let wrapped = SecKeyCreateEncryptedData(publicKey, BeebeebKeychainCore.eciesAlgorithm, masterKeyBytes as CFData, &cfErr) else {
      throw KeychainError.encryptionFailed
    }

    deleteWrappedItem(account: label)

    var attrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyService,
      kSecAttrAccount: label,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData: wrapped as Data,
    ]
    if let group = BeebeebKeychainCore.accessGroup { attrs[kSecAttrAccessGroup] = group }

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }

    // --- Extension SE key (.devicePasscode always — no biometric prompt from extensions) ---
    try storeExtensionWrappedKey(masterKeyBytes: masterKeyBytes, label: label)
    // Task 1722 (G6/G7): the Files key follows the Files mount, and never
    // fails this store — the vault key above is already written.
    syncFileProviderWrappedKey(masterKeyBytes: masterKeyBytes, label: label, allowed: fileProviderKeyAllowed)
    #endif
  }

  // MARK: - Files key lifecycle (task 1722 G1/G6/G7, review round 3)

  /// What `syncFileProviderWrappedKey` did.
  enum FileProviderKeyOutcome: Equatable {
    /// Exactly one Files key exists and its blob unwraps to the vault key
    /// (checked, or written and checked).
    case ready
    /// `allowed` said no before anything was written: there is no Files key.
    case notAllowed
    /// `allowed` said yes before the write and no after it: the write was undone.
    case revoked
    /// The key could not be written, or the keychain could not answer (device
    /// locked). Nothing half written is left; an existing key is left alone
    /// when the device is locked.
    case failed
  }

  /// What the extension's own lookup would find for a given vault key.
  enum FileProviderKeyCheck: Equatable {
    case matches
    case mismatch
    /// The keychain cannot answer now (errSecInteractionNotAllowed: locked).
    case unavailable
  }

  /// Task 1722 review round 3 (item 5): every Files key write and delete runs
  /// under this one lock. The writers run on Expo's serial queue (`store`,
  /// `load`, `setAccessControl`), on Swift Tasks (the foreground resume, a
  /// Settings toggle-off) and on background threads (a backup's `load`).
  /// Without it two writers could both miss the key and each generate one, and
  /// the blob ended up wrapped by a key the extension's lookup does not return:
  /// a permanent -1000. Held only around synchronous keychain calls, never
  /// across an `await`.
  private static let fileProviderKeyLock = NSLock()

  /// The File Provider's own wrapping key + blob (`storeFileProviderWrappedKey`)
  /// unwraps the vault key on an unlocked, passcode-protected device without
  /// Face ID or a passcode prompt, because Files has no authentication UI. It
  /// therefore exists only while the user has Beebeeb mounted in Files (the
  /// Settings copy: "Anyone who can unlock this iPhone can access the mounted
  /// Files location") and no sign-out purge is running: the rule `store`,
  /// `load` and `setAccessControl` pass in. They run on the module queue, as
  /// the purge does, so the purge generation the foreground resume also checks
  /// (`resumeFileProviderAuthenticationIfReady`) cannot move during them; a
  /// backup's `load` off that queue still sees the purge's marker.
  static func fileProviderKeyAllowed() -> Bool {
    BeebeebKeychainCore.fileProviderMountConsented() && !PlaintextStorageProtection.isPurgePending()
  }

  /// Makes the Files key follow `allowed`: no Files key when it says no;
  /// otherwise exactly one Files key whose blob unwraps to `masterKeyBytes`,
  /// written only when that is not already so.
  ///
  /// Best effort and never throws: a Files key that cannot be created must
  /// not fail a vault store or unlock (before task 1722 it did, which broke
  /// unlock or pushed `store` onto the weaker software-key fallback). Files
  /// then reports "Authentication Required" until a later provisioning works.
  ///
  /// Review round 3 (item 4): `allowed` is read under the lock before the
  /// write and again after it. A Settings toggle-off and a sign-out purge
  /// turn the consent off first and then delete the key through this lock,
  /// so each lands before the first read (nothing is written), between the
  /// reads (the write is undone here) or after this returns (its delete
  /// removes the key). The callers used to read the consent once, before a
  /// write that could land after the toggle-off's delete.
  ///
  /// Task 1722 round 4 (Q3, own keychain group): the first thing every call
  /// does, whatever `allowed` says, is delete the round-3 v1 Files key and
  /// blob from the shared group (`deleteLegacyFileProviderKeyLocked`). So the
  /// first unlock, store or foreground resume after the upgrade migrates: the
  /// old key is gone, and a new one is written into `filesAccessGroup` when
  /// Files is on. No key bytes move between groups; the new key is generated
  /// in the Files group and wraps the vault key afresh.
  @discardableResult
  static func syncFileProviderWrappedKey(
    masterKeyBytes: Data,
    label: String,
    allowed: () -> Bool
  ) -> FileProviderKeyOutcome {
    fileProviderKeyLock.lock()
    defer { fileProviderKeyLock.unlock() }
    deleteLegacyFileProviderKeyLocked()
    guard allowed() else {
      deleteFileProviderKeyLocked()
      return .notAllowed
    }
    let provisioned = provisionFileProviderKeyLocked(masterKeyBytes: masterKeyBytes, label: label)
    guard allowed() else {
      deleteFileProviderKeyLocked()
      RuntimeTrace.event("keychain.manager.files_key.provision_undone")
      return .revoked
    }
    return provisioned ? .ready : .failed
  }

  /// Under `fileProviderKeyLock`. Leaves exactly one Files key whose blob
  /// unwraps to `masterKeyBytes`, and writes only when that is not already so.
  /// Anything else (no key, no blob, a blob for another vault key, a blob
  /// wrapped by a key the lookup does not return, two keys under the Files
  /// tag) is replaced from nothing, so the new blob is wrapped by the only key
  /// the extension's lookup can return. A keychain that cannot answer now
  /// (locked) is left as it is: a lookup that fails there must not lead to a
  /// second key.
  private static func provisionFileProviderKeyLocked(masterKeyBytes: Data, label: String) -> Bool {
    switch checkFileProviderKey(masterKeyBytes: masterKeyBytes, label: label) {
    case .matches:
      return true
    case .unavailable:
      RuntimeTrace.event("keychain.manager.files_key.unverifiable")
      return false
    case .mismatch:
      break
    }
    deleteFileProviderKeyLocked()
    do {
      try storeFileProviderWrappedKey(masterKeyBytes: masterKeyBytes, label: label)
    } catch {
      RuntimeTrace.event("keychain.manager.files_key.provision_failed", ["error": String(describing: error)])
      deleteFileProviderKeyLocked()
      return false
    }
    if checkFileProviderKey(masterKeyBytes: masterKeyBytes, label: label) == .mismatch {
      RuntimeTrace.event("keychain.manager.files_key.provision_failed", ["error": "written key does not unwrap"])
      deleteFileProviderKeyLocked()
      return false
    }
    RuntimeTrace.event("keychain.manager.files_key.provisioned")
    return true
  }

  /// Review round 3 (item 5): "provisioned" is what the extension will find,
  /// not whether both keychain items exist. `.matches` only for exactly one
  /// key under the Files tag whose blob unwraps (the extension's own
  /// `loadFileProviderMasterKey`) to `masterKeyBytes`. The unwrapped copy is
  /// compared in constant time and zeroed.
  private static func checkFileProviderKey(masterKeyBytes: Data, label: String) -> FileProviderKeyCheck {
    guard let keys = fileProviderKeyCount() else { return .unavailable }
    guard keys == 1 else { return .mismatch }
    do {
      var unwrapped = try BeebeebKeychainCore.loadFileProviderMasterKey(label: label)
      defer { unwrapped.resetBytes(in: unwrapped.startIndex..<unwrapped.endIndex) }
      return constantTimeEqual(unwrapped, masterKeyBytes) ? .matches : .mismatch
    } catch BeebeebKeychainCore.LoadError.fileProviderKeyUnavailable(_, _, let code)
      where code == Int(errSecInteractionNotAllowed) {
      return .unavailable
    } catch {
      return .mismatch
    }
  }

  /// Keys under the Files tag in any of this app's access groups (no group in
  /// the query: the Files group, the shared group and a legacy group-less key
  /// all count); nil when the keychain cannot say now (locked). A key in the
  /// wrong group therefore makes the count wrong or the extension's lookup
  /// (Files group only) fail, and either way the writer starts again.
  private static func fileProviderKeyCount() -> Int? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: BeebeebKeychainCore.seKeyTagFiles,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return 0 }
    guard status == errSecSuccess else { return nil }
    return (result as? [Any])?.count ?? 0
  }

  private static func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    var difference: UInt8 = 0
    for (left, right) in zip(lhs, rhs) { difference |= left ^ right }
    return difference == 0
  }

  /// Removes every Files wrapping key (all of them, if a race before round 3
  /// left two) and its wrapped blob; the vault and share/backup keys are
  /// untouched. Takes the Files key lock, so it waits for a write in progress
  /// and removes what that write left.
  static func deleteFileProviderKey() {
    fileProviderKeyLock.lock()
    defer { fileProviderKeyLock.unlock() }
    deleteFileProviderKeyLocked()
  }

  /// Under `fileProviderKeyLock`. `SecItemDelete` removes every match.
  ///
  /// Task 1722 round 4 (Q3): the Files key and blob are deleted from the
  /// Files group, from the shared group and then without a group (every group
  /// this app has), so a copy in the wrong group cannot outlive a toggle-off
  /// or a sign-out either; the round-3 v1 items go too.
  private static func deleteFileProviderKeyLocked() {
    for group in [BeebeebKeychainCore.filesAccessGroup, BeebeebKeychainCore.accessGroup, nil] {
      deleteSEKey(tag: BeebeebKeychainCore.seKeyTagFiles, accessGroup: group)
      deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyServiceFiles, accessGroup: group)
    }
    deleteLegacyFileProviderKeyLocked()
  }

  /// Task 1722 round 4 (Q3, migration). Round-3 builds wrote the Files key
  /// (`legacySeKeyTagFilesV1`) and its blob into the shared group, which the
  /// Share extension is also entitled to. Deleted from the shared group and
  /// then without a group (every group this app has). Under
  /// `fileProviderKeyLock`. Returns whether anything was there.
  @discardableResult
  private static func deleteLegacyFileProviderKeyLocked() -> Bool {
    var removed = false
    for group in [BeebeebKeychainCore.accessGroup, nil] {
      if deleteSEKey(tag: BeebeebKeychainCore.legacySeKeyTagFilesV1, accessGroup: group) { removed = true }
      if deleteWrappedItems(service: BeebeebKeychainCore.legacyWrappedKeyServiceFilesV1, accessGroup: group) { removed = true }
    }
    if removed {
      RuntimeTrace.event("keychain.manager.files_key.legacy_removed")
    }
    return removed
  }

  /// Encrypt the master key under the extension SE key and persist alongside
  /// the primary blob for existing share/backup consumers. Files uses a
  /// separate wrapped blob and never falls back to this key or the primary.
  private static func storeExtensionWrappedKey(masterKeyBytes: Data, label: String) throws {
    let extSEKey = try getOrCreateExtensionSEKey()
    guard let extPublicKey = SecKeyCopyPublicKey(extSEKey) else {
      throw KeychainError.seKeyNotFound
    }

    var cfErr: Unmanaged<CFError>?
    guard let extWrapped = SecKeyCreateEncryptedData(extPublicKey, BeebeebKeychainCore.eciesAlgorithm, masterKeyBytes as CFData, &cfErr) else {
      throw KeychainError.encryptionFailed
    }

    deleteWrappedItem(account: label, service: BeebeebKeychainCore.wrappedKeyServiceExt)

    var extAttrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyServiceExt,
      kSecAttrAccount: label,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData: extWrapped as Data,
    ]
    if let group = BeebeebKeychainCore.accessGroup { extAttrs[kSecAttrAccessGroup] = group }
    let status = SecItemAdd(extAttrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }
  }

  // MARK: - Load

  /// Files has no authentication UI. Use a dedicated hardware wrapping key
  /// available only on this unlocked, passcode-equipped device. The shared
  /// backup/share wrapping key keeps its existing authentication policy.
  /// Task 1722 round 4 (Q3): the key and the blob go into
  /// `filesAccessGroup`, which the Share extension does not have.
  private static func storeFileProviderWrappedKey(masterKeyBytes: Data, label: String) throws {
    let key = try getOrCreateFileProviderSEKey()
    guard let publicKey = SecKeyCopyPublicKey(key) else {
      throw KeychainError.seKeyNotFound
    }
    var error: Unmanaged<CFError>?
    guard let wrapped = SecKeyCreateEncryptedData(publicKey, BeebeebKeychainCore.eciesAlgorithm, masterKeyBytes as CFData, &error) else {
      _ = error?.takeRetainedValue()
      throw KeychainError.encryptionFailed
    }
    var attributes: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyServiceFiles,
      kSecAttrAccount: label,
      kSecAttrAccessGroup: BeebeebKeychainCore.filesAccessGroup,
    ]
    let values: [CFString: Any] = [
      kSecAttrAccessible: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      kSecValueData: wrapped as Data,
    ]
    var status = SecItemUpdate(attributes as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      attributes.merge(values) { _, new in new }
      status = SecItemAdd(attributes as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw KeychainError.writeError(status) }
  }

  /// Decrypt and return the master key. Returns nil if no key is stored.
  /// Triggers biometric/passcode prompt if the SE access control requires it.
  ///
  /// Delegates the SE-wrap read to `BeebeebKeychainCore`. On a successful
  /// read, also (re)writes the extension-wrapped blob so backup extensions
  /// can read the key without prompting; if the read came from a legacy
  /// no-access-group keychain item, re-stores with the access group set so
  /// the migration is idempotent.
  static func load(label: String) throws -> Data? {
    RuntimeTrace.event("keychain.manager.load.request", [
      "label": label,
      "mode": "primaryOnly",
      "promptMayAppear": true
    ])
    #if DEBUG && targetEnvironment(simulator)
    if let simulatorKey = try loadSimulatorSoftwareKey(label: label) {
      RuntimeTrace.event("keychain.manager.load.simulator_success", ["label": label])
      return simulatorKey
    }
    #endif

    // No wrapped blob at all → no key was ever provisioned here (fresh install /
    // device restore that dropped the SE blob). Return nil BEFORE evaluating any
    // biometric so a genuine recovery case never flashes a Face ID sheet. The JS
    // layer maps this nil → { reason: 'no_key' } → recovery-phrase prompt.
    guard BeebeebKeychainCore.fetchWrappedBlob(service: BeebeebKeychainCore.wrappedKeyService, label: label) != nil else {
      RuntimeTrace.event("keychain.manager.load.miss", ["label": label])
      return nil
    }

    // A key IS provisioned. Perform EXACTLY ONE explicit, user-initiated
    // evaluation (task 0882 primary fix) and reuse it for the SE decrypt via
    // kSecUseAuthenticationContext — this REPLACES the old too-early implicit
    // biometric raised inside SecKeyCreateDecryptedData (which fired before the
    // Secure Enclave was warm on a true cold restart, returned nil, and got
    // mislabeled as a generic `seKeyNotFound` → JS `transient`). Preserves the
    // 0792 exactly-one-prompt invariant (the explicit eval replaces, never adds,
    // a prompt) and runs off the main thread (see authenticateForPrimaryLoad).
    let authContext = try authenticateForPrimaryLoad(label: label)

    // Main app uses .primaryOnly — biometric/passcode prompt is acceptable
    // here. Files uses .fileProviderOnly; Share uses .extensionThenPrimary.
    var decryptError: Unmanaged<CFError>?
    guard let plaintextData = BeebeebKeychainCore.loadMasterKey(
      label: label,
      mode: .primaryOnly,
      authContext: authContext,
      decryptError: &decryptError
    ) else {
      // Auth succeeded but the SE decrypt still returned nil this early in
      // process start. Map the (previously discarded) CFError to a typed reason
      // instead of a blanket seKeyNotFound (task 0882 companion). The common
      // case is a transient SE hiccup → notWarm → JS retries, and the retry
      // reuses `authContext` (no second prompt).
      let reason = BeebeebKeychainCore.classifyDecryptError(decryptError)
      RuntimeTrace.event("keychain.manager.load.decrypt_failed", [
        "label": label,
        "reason": reason.rawValue
      ])
      throw KeychainError.vaultAuth(reason)
    }

    // Keep the extension-wrapped blob in sync so backup extensions can read.
    try storeExtensionWrappedKey(masterKeyBytes: plaintextData, label: label)
    // Task 1722 (G1/G6/G7): make the Files key unwrap to this vault key while
    // Files is mounted, remove it otherwise; never fail the unlock over it.
    syncFileProviderWrappedKey(masterKeyBytes: plaintextData, label: label, allowed: fileProviderKeyAllowed)

    // Idempotent re-store under the access group. If the read came from
    // legacy no-access-group storage, this migrates it forward; if it
    // already had the access group, this is a no-op rewrite.
    try? store(masterKeyBytes: plaintextData, label: label)

    RuntimeTrace.event("keychain.manager.load.success", ["label": label])
    return plaintextData
  }

  // MARK: - Primary-load biometric evaluation (task 0882)

  /// Run EXACTLY ONE explicit, user-initiated biometric/passcode evaluation for
  /// the primary master-key load and return the satisfied `LAContext` so the SE
  /// decrypt can reuse it (`kSecUseAuthenticationContext`) without raising a
  /// second prompt (0792 exactly-one-prompt). This replaces the too-early
  /// IMPLICIT evaluation that `SecKeyCreateDecryptedData` used to raise on its
  /// own — that fired before the Secure Enclave was warm on a cold restart and
  /// silently failed (task 0882).
  ///
  /// Policy matches the primary SE key's access-control variant
  /// (`getOrCreateSEKey`, driven by `requiresBiometric`):
  ///   - `.biometryAny`    → `.deviceOwnerAuthenticationWithBiometrics`
  ///   - `.devicePasscode` → `.deviceOwnerAuthentication` (biometrics OR
  ///                          passcode — preserves the passcode-only fallback).
  ///
  /// Threading: `evaluatePolicy` is asynchronous and iOS presents its sheet on
  /// the main thread. We therefore MUST NOT block the main thread while waiting
  /// (that would prevent the sheet from presenting → deadlock). Expo
  /// AsyncFunctions already invoke this off the main thread; we wait on a
  /// semaphore from that background thread (main stays free for the sheet), and
  /// defensively fail-closed (retryable) rather than block if ever called on
  /// main.
  ///
  /// Throws `KeychainError.vaultAuth(reason)` on cancel / failure / lockout /
  /// unavailable so the JS layer decides retry-vs-surface (fail-closed, 0428).
  private static func authenticateForPrimaryLoad(label: String) throws -> LAContext {
    let context = LAContext()
    // Short reuse window so the immediately-following SE decrypt (and a cheap
    // post-auth transient retry) are covered by this single evaluation without
    // leaving a broad ambient-auth window open.
    context.touchIDAuthenticationAllowableReuseDuration = 10
    let reason = "Unlock your Beebeeb vault"

    let requireBiometricPolicy = requiresBiometric
    let policy: LAPolicy = requireBiometricPolicy
      ? .deviceOwnerAuthenticationWithBiometrics
      : .deviceOwnerAuthentication
    if requireBiometricPolicy {
      // No passcode-fallback button for the biometrics-only key (mirrors the
      // RN lock screen's disableDeviceFallback); the in-app password button is
      // the explicit fallback. Passcode-allowed keys keep the default sheet.
      context.localizedFallbackTitle = ""
    }

    var canEvalError: NSError?
    guard context.canEvaluatePolicy(policy, error: &canEvalError) else {
      RuntimeTrace.event("keychain.manager.load.cannot_evaluate", [
        "label": label,
        "requiresBiometric": requireBiometricPolicy,
        "error": canEvalError?.localizedDescription ?? "unknown"
      ])
      // Subsystem not ready yet this early in start (or biometrics not
      // enrolled) — retryable, not a user failure.
      throw KeychainError.vaultAuth(.notAvailable)
    }

    // Never block the main thread (invariant: no main-thread deadlock). Expo
    // AsyncFunctions run off-main; if we are ever on main, bail retryably rather
    // than risk stalling the UI that must present the sheet.
    if Thread.isMainThread {
      RuntimeTrace.event("keychain.manager.load.evaluate_on_main_skipped", ["label": label])
      throw KeychainError.vaultAuth(.notWarm)
    }

    let semaphore = DispatchSemaphore(value: 0)
    var evalSuccess = false
    var evalError: Error?
    context.evaluatePolicy(policy, localizedReason: reason) { success, error in
      evalSuccess = success
      evalError = error
      semaphore.signal()
    }
    semaphore.wait()

    if evalSuccess {
      RuntimeTrace.event("keychain.manager.load.evaluate_success", [
        "label": label,
        "requiresBiometric": requireBiometricPolicy
      ])
      return context
    }

    let failureReason = classifyLAError(evalError)
    RuntimeTrace.event("keychain.manager.load.evaluate_failed", [
      "label": label,
      "reason": failureReason.rawValue
    ])
    throw KeychainError.vaultAuth(failureReason)
  }

  /// Map an `LAError` from `evaluatePolicy` to a typed reason (task 0882).
  private static func classifyLAError(_ error: Error?) -> BeebeebKeychainCore.AuthFailureReason {
    guard let laError = error as? LAError else { return .authFailed }
    switch laError.code {
    case .userCancel, .systemCancel, .appCancel, .userFallback:
      return .userCanceled
    case .authenticationFailed:
      return .authFailed
    case .biometryLockout:
      return .biometryLockout
    case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet, .invalidContext, .notInteractive:
      return .notAvailable
    default:
      return .notWarm
    }
  }

  // MARK: - Delete

  /// Remove the SE wrapping key and all wrapped key blobs. Irreversible.
  static func delete() {
    deleteSEKey()
    deleteWrappedItems()
    #if DEBUG && targetEnvironment(simulator)
    deleteSimulatorSoftwareKeys()
    #endif
  }

  // MARK: - Access control toggle

  /// Switch between .devicePasscode (background OK) and .biometryAny (foreground only).
  ///
  /// If a wrapping key already exists, all stored master keys are decrypted with the old
  /// SE key, the old key is deleted, a new SE key is generated with the updated access
  /// control, and all master keys are re-wrapped. Requires the user to authenticate with
  /// the current policy before switching.
  static func setAccessControl(requireBiometric: Bool) throws {
    let wasBiometric = requiresBiometric
    requiresBiometric = requireBiometric
    RuntimeTrace.event("keychain.manager.set_access_control.request", [
      "requireBiometric": requireBiometric,
      "wasBiometric": wasBiometric,
      "promptMayAppear": wasBiometric
    ])

    guard wasBiometric != requireBiometric,
          let oldSEKey = BeebeebKeychainCore.findSEKey(tag: BeebeebKeychainCore.seKeyTag) else {
      RuntimeTrace.event("keychain.manager.set_access_control.noop", [
        "requireBiometric": requireBiometric,
        "wasBiometric": wasBiometric
      ])
      return
    }

    // Fetch all wrapped blobs so we can re-wrap them under the new SE key
    var fetchQuery: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: BeebeebKeychainCore.wrappedKeyService,
      kSecReturnData: true,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll,
    ]
    if let group = BeebeebKeychainCore.accessGroup { fetchQuery[kSecAttrAccessGroup] = group }

    var allItems: CFTypeRef?
    let fetchStatus = SecItemCopyMatching(fetchQuery as CFDictionary, &allItems)
    let items = fetchStatus == errSecSuccess ? (allItems as? [[CFString: Any]] ?? []) : []
    RuntimeTrace.event("keychain.manager.set_access_control.items_fetched", [
      "count": items.count,
      "status": fetchStatus
    ])

    // Decrypt each blob with the old SE key (triggers auth prompt if needed)
    var plaintexts: [(account: String, data: Data)] = []
    for item in items {
      guard let wrapped = item[kSecValueData] as? Data,
            let account = item[kSecAttrAccount] as? String else { continue }
      var cfErr: Unmanaged<CFError>?
      if let plain = SecKeyCreateDecryptedData(oldSEKey, BeebeebKeychainCore.eciesAlgorithm, wrapped as CFData, &cfErr) {
        plaintexts.append((account: account, data: plain as Data))
      }
    }

    // Delete old primary SE key
    deleteSEKey(tag: BeebeebKeychainCore.seKeyTag)

    // Generate new primary SE key with updated access control
    let newFlags: SecAccessControlCreateFlags = requireBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]
    let newSEKey = try generateSEKey(tag: BeebeebKeychainCore.seKeyTag, flags: newFlags)
    guard let newPublicKey = SecKeyCopyPublicKey(newSEKey) else {
      throw KeychainError.seKeyNotFound
    }

    // Re-wrap each master key under the new primary SE key
    for item in plaintexts {
      var cfErr: Unmanaged<CFError>?
      guard let rewrapped = SecKeyCreateEncryptedData(newPublicKey, BeebeebKeychainCore.eciesAlgorithm, item.data as CFData, &cfErr) else {
        continue
      }
      deleteWrappedItem(account: item.account)
      var attrs: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: BeebeebKeychainCore.wrappedKeyService,
        kSecAttrAccount: item.account,
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        kSecValueData: rewrapped as Data,
      ]
      if let group = BeebeebKeychainCore.accessGroup { attrs[kSecAttrAccessGroup] = group }
      SecItemAdd(attrs as CFDictionary, nil)
    }

    // Always keep the extension wrapped key available. The File Provider never
    // falls back to the primary key, because that key may require Face ID from
    // an extension process and can cause repeated system prompts in Files.app.
    for item in plaintexts {
      try storeExtensionWrappedKey(masterKeyBytes: item.data, label: item.account)
      // Task 1722 (G6/G7): mounted-only and best effort, as in `store`/`load`;
      // the rule is read under the Files key lock, before and after the write.
      syncFileProviderWrappedKey(masterKeyBytes: item.data, label: item.account, allowed: fileProviderKeyAllowed)
    }
    RuntimeTrace.event("keychain.manager.set_access_control.success", [
      "requireBiometric": requireBiometric,
      "rewrapped": plaintexts.count
    ])
  }

  /// Switch access control using the already-unlocked master key.
  ///
  /// The JS layer keeps the master key in memory only while the vault is open.
  /// When the user enables Face ID from Settings, using that plaintext avoids
  /// one extra prompt under the old device-passcode policy.
  static func replaceAccessControl(requireBiometric: Bool, masterKeyBytes: Data, label: String) throws {
    RuntimeTrace.event("keychain.manager.replace_access_control.request", [
      "requireBiometric": requireBiometric,
      "label": label
    ])
    guard masterKeyBytes.count == 32 else {
      RuntimeTrace.event("keychain.manager.replace_access_control.invalid_key_size", [
        "label": label,
        "size": masterKeyBytes.count
      ])
      throw KeychainError.invalidMasterKeySize
    }

    let previousPolicy = requiresBiometric
    deleteSEKey()
    deleteWrappedItems()
    requiresBiometric = requireBiometric

    do {
      try store(masterKeyBytes: masterKeyBytes, label: label)
      RuntimeTrace.event("keychain.manager.replace_access_control.success", [
        "requireBiometric": requireBiometric,
        "label": label
      ])
    } catch {
      deleteSEKey()
      deleteWrappedItems()
      requiresBiometric = previousPolicy
      try? store(masterKeyBytes: masterKeyBytes, label: label)
      RuntimeTrace.event("keychain.manager.replace_access_control.failed_rolled_back", [
        "requireBiometric": requireBiometric,
        "label": label,
        "error": error.localizedDescription
      ])
      throw error
    }
  }

  // MARK: - Arbitrary string storage (for backup token, server URL, etc.)
  //
  // Used to keep the backup auth token and server URL out of UserDefaults.
  // UserDefaults plist files are included verbatim in unencrypted iTunes /
  // iCloud backups, so a bearer token there leaks on device restore /
  // forensic extraction. Keychain items written with
  // `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` do NOT migrate via
  // unencrypted backups, which is the property we need (task 0430).
  //
  // The access group is the same as for the master key, so background
  // tasks running in the main app's address space and extensions sharing
  // the `keychain-access-groups` entitlement can read the value.
  //
  // String storage is intentionally not consolidated into BeebeebKeychainCore
  // — only the main app writes these, and the orthogonal API would just
  // expand the shared surface for no benefit (per ios-engineer's note on
  // 0436).

  private static let stringStorageService = "io.beebeeb.string-storage"

  static func storeString(_ value: String, key: String) throws {
    let data = Data(value.utf8)
    deleteString(key: key)

    var attrs: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: stringStorageService,
      kSecAttrAccount: key,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData: data,
    ]
    if let group = BeebeebKeychainCore.accessGroup { attrs[kSecAttrAccessGroup] = group }

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError.writeError(status) }
  }

  /// Returns the stored string for `key`. Performs a one-time on-demand
  /// migration: if the keychain entry is missing but UserDefaults still
  /// holds the legacy value, copy it into the keychain and remove the
  /// UserDefaults key. UserDefaults is only cleared after the keychain
  /// write returns `errSecSuccess` — never partially, to avoid losing the
  /// only copy of an auth token if the keychain write fails.
  static func loadString(key: String) -> String? {
    if let existing = readStringFromKeychain(key: key) {
      return existing
    }

    let defaults = UserDefaults.standard
    guard let legacy = defaults.string(forKey: key) else { return nil }
    do {
      try storeString(legacy, key: key)
      defaults.removeObject(forKey: key)
      return legacy
    } catch {
      NSLog("[Beebeeb] keychain migration failed for \(key): \(error.localizedDescription) — falling back to UserDefaults until next launch")
      return legacy
    }
  }

  static func deleteString(key: String) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: stringStorageService,
      kSecAttrAccount: key,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)
    // Also clear any legacy UserDefaults entry so the migration path can't
    // resurrect a stale value on the next read.
    UserDefaults.standard.removeObject(forKey: key)
  }

  private static func readStringFromKeychain(key: String) -> String? {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: stringStorageService,
      kSecAttrAccount: key,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }

    var result: CFTypeRef?
    var status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound, BeebeebKeychainCore.accessGroup != nil {
      query.removeValue(forKey: kSecAttrAccessGroup)
      status = SecItemCopyMatching(query as CFDictionary, &result)
    }
    guard status == errSecSuccess, let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  // MARK: - Private write helpers

  private static func getOrCreateSEKey() throws -> SecKey {
    if let existing = BeebeebKeychainCore.findSEKey(tag: BeebeebKeychainCore.seKeyTag) { return existing }
    let flags: SecAccessControlCreateFlags = requiresBiometric
      ? [.privateKeyUsage, .biometryAny]
      : [.privateKeyUsage, .devicePasscode]
    return try generateSEKey(tag: BeebeebKeychainCore.seKeyTag, flags: flags)
  }

  private static func getOrCreateExtensionSEKey() throws -> SecKey {
    if let existing = BeebeebKeychainCore.findSEKey(tag: BeebeebKeychainCore.seKeyTagExt) { return existing }
    return try generateSEKey(tag: BeebeebKeychainCore.seKeyTagExt, flags: [.privateKeyUsage, .devicePasscode])
  }

  /// Task 1722 round 4 (Q3): looked up and generated in `filesAccessGroup`
  /// only. The writer deletes before it stores, so this normally generates.
  private static func getOrCreateFileProviderSEKey() throws -> SecKey {
    if let key = BeebeebKeychainCore.findSEKeyReportingStatus(
      tag: BeebeebKeychainCore.seKeyTagFiles,
      inAccessGroup: BeebeebKeychainCore.filesAccessGroup
    ).key {
      return key
    }
    return try generateSEKey(
      tag: BeebeebKeychainCore.seKeyTagFiles,
      flags: [.privateKeyUsage],
      protection: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      accessGroup: BeebeebKeychainCore.filesAccessGroup
    )
  }

  /// Generate a Secure Enclave P-256 key with the given tag and access control flags,
  /// in `accessGroup` (the shared group unless a caller names another one).
  private static func generateSEKey(
    tag: Data,
    flags: SecAccessControlCreateFlags,
    protection: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    accessGroup: String? = BeebeebKeychainCore.accessGroup
  ) throws -> SecKey {
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault,
      protection,
      flags,
      nil
    ) else {
      throw KeychainError.seKeyGenerationFailed
    }

    var attributes: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs: [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: tag,
        kSecAttrAccessControl: access,
      ] as [CFString: Any],
    ]
    if let group = accessGroup { attributes[kSecAttrAccessGroup] = group }

    var cfErr: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &cfErr) else {
      throw KeychainError.seKeyGenerationFailed
    }
    return key
  }

  private static func deleteWrappedItem(account: String, service: String = BeebeebKeychainCore.wrappedKeyService) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: account,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)
  }

  private static func deleteSEKey() {
    deleteSEKey(tag: BeebeebKeychainCore.seKeyTag)
    deleteSEKey(tag: BeebeebKeychainCore.seKeyTagExt)
    // Task 1722 review round 3: through the Files key lock, like every Files key write.
    deleteFileProviderKey()
  }

  private static func deleteSEKey(tag: Data) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: tag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)

    if BeebeebKeychainCore.accessGroup != nil {
      var legacyQuery = query
      legacyQuery.removeValue(forKey: kSecAttrAccessGroup)
      SecItemDelete(legacyQuery as CFDictionary)
    }
  }

  /// Task 1722 round 4 (Q3): deletes every SE key under `tag` in
  /// `accessGroup`, or, with nil, in every access group this app has.
  /// Returns whether anything was deleted.
  @discardableResult
  private static func deleteSEKey(tag: Data, accessGroup: String?) -> Bool {
    var query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrApplicationTag: tag,
      kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,
    ]
    if let accessGroup { query[kSecAttrAccessGroup] = accessGroup }
    return SecItemDelete(query as CFDictionary) == errSecSuccess
  }

  private static func deleteWrappedItems() {
    deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyService)
    deleteWrappedItems(service: BeebeebKeychainCore.wrappedKeyServiceExt)
    // Task 1722 review round 3: the Files key and its blob, through the Files key lock.
    deleteFileProviderKey()
  }

  private static func deleteWrappedItems(service: String) {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
    ]
    if let group = BeebeebKeychainCore.accessGroup { query[kSecAttrAccessGroup] = group }
    SecItemDelete(query as CFDictionary)

    if BeebeebKeychainCore.accessGroup != nil {
      query.removeValue(forKey: kSecAttrAccessGroup)
      SecItemDelete(query as CFDictionary)
    }
  }

  /// Task 1722 round 4 (Q3): deletes every wrapped blob under `service` in
  /// `accessGroup`, or, with nil, in every access group this app has.
  /// Returns whether anything was deleted.
  @discardableResult
  private static func deleteWrappedItems(service: String, accessGroup: String?) -> Bool {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
    ]
    if let accessGroup { query[kSecAttrAccessGroup] = accessGroup }
    return SecItemDelete(query as CFDictionary) == errSecSuccess
  }

  #if DEBUG && targetEnvironment(simulator)
  private static func simulatorSoftwareKeyQuery(label: String? = nil) -> [CFString: Any] {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: simulatorSoftwareKeyService,
    ]
    if let label {
      query[kSecAttrAccount] = label
    }
    if let group = BeebeebKeychainCore.accessGroup {
      query[kSecAttrAccessGroup] = group
    }
    return query
  }

  private static func storeSimulatorSoftwareKey(masterKeyBytes: Data, label: String) throws {
    var attrs = simulatorSoftwareKeyQuery(label: label)
    SecItemDelete(attrs as CFDictionary)

    attrs[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    attrs[kSecValueData] = masterKeyBytes

    let status = SecItemAdd(attrs as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainError.writeError(status)
    }
  }

  private static func loadSimulatorSoftwareKey(label: String) throws -> Data? {
    var query = simulatorSoftwareKeyQuery(label: label)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw KeychainError.readError(status)
    }
    return result as? Data
  }

  private static func deleteSimulatorSoftwareKeys() {
    SecItemDelete(simulatorSoftwareKeyQuery() as CFDictionary)
  }
  #endif
}
