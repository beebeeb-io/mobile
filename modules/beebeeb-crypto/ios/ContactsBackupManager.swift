import Foundation
import Contacts
import CryptoKit

final class ContactsBackupManager {
  static let shared = ContactsBackupManager()
  /// Task 1531 [P1-B] (round 5 delta review): was a single fixed key with
  /// NO account dimension — an account switch (A → B) with an identical
  /// contact list hash-matched A's last upload and was silently skipped for
  /// B, even though B's vault has nothing in it. Now a prefix; the actual
  /// key is derived from `lastHashPrefix` + a hash of the account id (see
  /// `hashKey(for:)`), so the dedup digest is scoped per account, mirroring
  /// `CalendarBackupManager.lastHashPrefix`'s existing per-calendar scoping.
  private static let lastHashPrefix = "io.beebeeb.contactsBackupLastHash."
  private static let lastScanAtKey = "io.beebeeb.contactsBackupLastScanAt"
  private static let lastScanCountKey = "io.beebeeb.contactsBackupLastScanCount"
  private static let lastUploadAtKey = "io.beebeeb.contactsBackupLastUploadAt"
  /// Task 1531 [P2] round 6 (delta review 3, finding N5): the SINGLE fixed
  /// (non-per-account) digest key this class wrote before the [P1-B]
  /// (round 5) per-account `lastHashPrefix` scoping. No code has read or
  /// written it since that round, but nothing ever deleted it either — an
  /// orphaned leftover on any device that had Contacts backup enabled
  /// before round 5. Cleaned up once in `reset()` and once at `init()` (see
  /// both below). Deliberately NOT `lastHashPrefix`-prefixed (it predates
  /// the prefix, and has no trailing `.`), so the `hasPrefix(lastHashPrefix)`
  /// sweeps elsewhere in this file never touch it.
  private static let legacyLastHashKey = "io.beebeeb.contactsBackupLastHash"

  private var authToken: String?
  /// Task 1531 [P0]: the account `authToken` belongs to. Set alongside
  /// `authToken` by `enable(authToken:userId:)`, cleared alongside it by
  /// `disable()`. Passed to `NativeEncryptedBackupUploader` on every upload
  /// so a stale in-flight export can't land in the wrong account's vault
  /// after an account switch — see `NativeEncryptedBackupUploader.upload`.
  private var accountId: String?

  /// Whether this manager currently believes Contacts backup is enabled
  /// (has a bound account). Read by `disablePhotoBackup`
  /// (BeebeebCryptoModule.swift) — task 1531 [P1-A follow-up], round 5 —
  /// to decide whether turning off Camera Roll backup ALONE may also clear
  /// the shared `NativeBackupEngine.currentAccountId` that Contacts backup
  /// now binds to via `bindAccount`.
  var isBound: Bool { accountId != nil }

  private var parentFolderId: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.contactsBackupParentFolderId") }
    set {
      if let newValue, !newValue.isEmpty {
        UserDefaults.standard.set(newValue, forKey: "io.beebeeb.contactsBackupParentFolderId")
      } else {
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.contactsBackupParentFolderId")
      }
    }
  }

  // Server URL is keychain-only (task 0430). No localhost fallback (task 0442) —
  // workspace rule forbids defaulting to dev hosts in production code paths.
  // Returns nil when the keychain slot is empty; the upload site guards and
  // aborts cleanly.
  private var serverBaseURL: String? {
    KeychainManager.loadString(key: "io.beebeeb.serverURL")
  }

  private init() {
    NotificationCenter.default.addObserver(
      forName: NSNotification.Name("CNContactStoreDidChangeNotification"),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      guard self?.authToken != nil, self?.accountId != nil else { return }
      self?.backup()
    }
    // Task 1531 [P2] round 6 (finding N5): one-time cleanup of the orphaned
    // pre-[P1-B] legacy digest key — see `legacyLastHashKey`'s doc comment.
    // `removeObject` is a no-op once the key is gone, so calling this on
    // every process launch (this initializer runs exactly once per process,
    // being a lazy static singleton) is cheap and doesn't need its own
    // "already migrated" flag.
    UserDefaults.standard.removeObject(forKey: Self.legacyLastHashKey)
  }

  func enable(authToken: String, userId: String, runNow: Bool = true) {
    self.authToken = authToken
    self.accountId = userId
    // Task 1531 [P2] round 6 (delta review 3, finding N3): also mirror the
    // token into the ENGINE's own Keychain slot (`io.beebeeb.backupToken`,
    // via `NativeBackupEngine.token`'s setter) — not just this manager's
    // private `authToken` above. `enablePhotoBackup` already does this
    // (`engine.token = authToken` in BeebeebCryptoModule.swift); without
    // it here, a Contacts/Calendar-only user (Camera Roll backup never
    // enabled) left that Keychain slot nil forever, so the NEXT
    // `mirrorSessionToAppGroup(token, …)` call (BeebeebCryptoModule.swift —
    // fires on nearly every app foreground/token mirror, not just sign-in)
    // compared its stored `previousToken` (nil) against the current token,
    // always saw a "change", and spuriously unbound `currentAccountId` +
    // dropped the cached master-key handle — even though the SAME token
    // had been in use the whole time. See that function's "no token-REFRESH
    // path" doc comment (round 5, P1) for why any stored-token diff is
    // otherwise correctly treated as a fresh sign-in.
    NativeBackupEngine.shared.token = authToken
    // Task 1531 [P1-A] (round 5 delta review): bind at the ENGINE level
    // too — `NativeEncryptedBackupUploader.requireAccountBinding` reads
    // `NativeBackupEngine.shared.currentAccountId`, NOT this class's own
    // `accountId` above. Without this call a Contacts-only user (Camera
    // Roll backup never enabled) had `currentAccountId == nil` forever and
    // every upload refused with `.accountMismatch`. Also purges any staged
    // Camera-Roll ciphertext left by a DIFFERENT previous account on this
    // device as a side effect — the same purge `enablePhotoBackup` already
    // triggers via `start()`, now guaranteed regardless of which backup
    // surface is enabled first.
    NativeBackupEngine.shared.bindAccount(userId: userId)
    RuntimeTrace.event("backup.contacts.enable", ["runNow": runNow])
    // Task 1531 [P2] round 6 (finding N2): a refused/failed upload never
    // records the dedup hash (P1-B, round 5 — `shouldUpload`/
    // `recordUploadSuccess` above), but the warm-up path
    // (`resumeContactsBackup`, `runNow: false` — called from
    // backup-context.tsx's mount-time sequencing) skips `backup()` entirely
    // when `runNow` is false. A refused export (account-mismatch while a
    // stale token was cached, offline, no master key yet, …) therefore sat
    // un-retried until the NEXT genuine contacts edit fired
    // `CNContactStoreDidChangeNotification` — which could be days, or
    // never. Run once on warm-up too when there is no recorded successful
    // upload for THIS account yet, so a previously-refused (or
    // never-attempted) export gets retried on every app mount/foreground,
    // not just on the next real contact-list change.
    let hasUploadedForThisAccount = UserDefaults.standard.string(forKey: Self.hashKey(for: userId)) != nil
    let shouldRunNow = runNow || !hasUploadedForThisAccount
    CNContactStore().requestAccess(for: .contacts) { [weak self] granted, _ in
      RuntimeTrace.event("backup.contacts.permission", ["granted": granted])
      guard granted else { return }
      if shouldRunNow {
        self?.backup()
      }
    }
  }

  func disable() {
    authToken = nil
    accountId = nil
  }

  /// Task 0819: self-heal after the server-side backup copy is gone. Clears the
  /// scan/upload timestamps AND every per-account SHA-256 dedup digest (all
  /// keys under `lastHashPrefix`) so the NEXT backup run RE-UPLOADS instead
  /// of being suppressed as "unchanged", and the status tile resets.
  /// Data-safe — only local UserDefaults bookkeeping is cleared; the
  /// contacts themselves and the configured parent folder are kept.
  func reset() {
    let defaults = UserDefaults.standard
    for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.lastHashPrefix) {
      defaults.removeObject(forKey: key)
    }
    defaults.removeObject(forKey: Self.lastScanAtKey)
    defaults.removeObject(forKey: Self.lastScanCountKey)
    defaults.removeObject(forKey: Self.lastUploadAtKey)
    // Task 1531 [P2] round 6 (finding N5): see `legacyLastHashKey`'s doc
    // comment — belt-and-braces cleanup alongside the `init()` sweep.
    defaults.removeObject(forKey: Self.legacyLastHashKey)
    RuntimeTrace.event("backup.contacts.reset")
  }

  func configure(parentFolderId: String?) {
    self.parentFolderId = parentFolderId
    RuntimeTrace.event("backup.contacts.configure", [
      "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
    ])
  }

  func backup() {
    guard let token = authToken, let accountId, !accountId.isEmpty else { return }
    RuntimeTrace.event("backup.contacts.start")
    DispatchQueue.global(qos: .background).async { [weak self] in
      guard let self else { return }
      do {
        let export = try self.exportContacts()
        self.recordScan(count: export.count)
        RuntimeTrace.event("backup.contacts.exported", [
          "bytes": export.data.count,
          "contactCount": export.count
        ])
        let digest = Self.contentDigest(data: export.data)
        guard self.shouldUpload(digest: digest, accountId: accountId) else {
          RuntimeTrace.event("backup.contacts.skipped_unchanged")
          return
        }
        self.upload(data: export.data, fileName: "contacts.vcf", mimeType: "text/vcard", token: token, accountId: accountId, digest: digest)
      } catch {
        RuntimeTrace.event("backup.contacts.failed", ["error": error.localizedDescription])
        // Contact export failed — permissions not granted or empty contacts
      }
    }
  }

  func status() -> [String: Any] {
    let defaults = UserDefaults.standard
    // Task 1531 [P2] round 6 (delta review 3, finding N6): was `hasPrefix`
    // across EVERY account's dedup key ever written on this device — a
    // PREVIOUS account's leftover hash key (round 5's per-account
    // `lastHashPrefix` scoping never deletes an outgoing account's key)
    // made `hasStoredHash`/`hasKnownBackupState` read `true` for a
    // brand-new account on the same device that has never itself uploaded
    // a single contact. Scope to the currently bound account's own key.
    let hasStoredHash = accountId.map { defaults.string(forKey: Self.hashKey(for: $0)) != nil } ?? false
    let hasKnownBackupState =
      hasStoredHash ||
      defaults.string(forKey: Self.lastScanAtKey) != nil ||
      defaults.string(forKey: Self.lastUploadAtKey) != nil
    return [
      "lastScanAt": defaults.string(forKey: Self.lastScanAtKey) as Any? ?? NSNull(),
      "lastScanCount": defaults.integer(forKey: Self.lastScanCountKey),
      "lastUploadAt": defaults.string(forKey: Self.lastUploadAtKey) as Any? ?? NSNull(),
      "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
      // Task 0819: the category folder id (Contacts/) so the reconcile can detect
      // it's gone from /files/index and trigger a self-heal reset.
      "parentFolderId": parentFolderId as Any? ?? NSNull(),
      "hasKnownBackupState": hasKnownBackupState
    ]
  }

  private func exportContacts() throws -> (data: Data, count: Int) {
    let store = CNContactStore()
    let keys: [CNKeyDescriptor] = [CNContactVCardSerialization.descriptorForRequiredKeys()]
    let request = CNContactFetchRequest(keysToFetch: keys)
    var contacts: [CNContact] = []
    try store.enumerateContacts(with: request) { contact, _ in
      contacts.append(contact)
    }
    return (try CNContactVCardSerialization.data(with: contacts), contacts.count)
  }

  private func recordScan(count: Int) {
    let now = ISO8601DateFormatter().string(from: Date())
    let defaults = UserDefaults.standard
    defaults.set(now, forKey: Self.lastScanAtKey)
    defaults.set(count, forKey: Self.lastScanCountKey)
    RuntimeTrace.event("backup.contacts.scan_recorded", [
      "contactCount": count,
      "lastScanAt": now
    ])
  }

  /// Task 1531 [P1-B] (round 5 delta review): records the dedup digest ONLY
  /// on confirmed upload success — see `upload()`'s `.success` branch,
  /// the sole caller. `shouldUpload` below never writes state itself.
  private func recordUploadSuccess(digest: String, accountId: String) {
    let now = ISO8601DateFormatter().string(from: Date())
    let defaults = UserDefaults.standard
    defaults.set(now, forKey: Self.lastUploadAtKey)
    defaults.set(digest, forKey: Self.hashKey(for: accountId))
  }

  /// SHA-256 hex digest of an export, used as the per-account dedup key.
  /// Pure — computing it never writes state (see `shouldUpload` below).
  private static func contentDigest(data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  /// Per-account UserDefaults key for the dedup digest. Hashes `accountId`
  /// (mirrors `CalendarBackupManager.stateKeyComponent(for:)`) rather than
  /// interpolating it raw — defensive against a future account-id format
  /// that isn't UserDefaults-key-safe, and consistent with the existing
  /// per-calendar key derivation.
  private static func hashKey(for accountId: String) -> String {
    lastHashPrefix + SHA256.hash(data: Data(accountId.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  /// Task 1531 [P1-B] (round 5 delta review): READ-ONLY — reports whether
  /// `digest` differs from the digest last SUCCESSFULLY uploaded for THIS
  /// `accountId`. The previous version wrote the digest here, BEFORE the
  /// upload ran, so a refused/failed upload (network error, account-
  /// mismatch refusal, no cached master key — see
  /// `NativeEncryptedBackupUploader`) was indistinguishable from a
  /// completed one: the export was silently treated as "already backed up"
  /// forever, or until the contact list changed again. State is now
  /// written only by `recordUploadSuccess`, from the upload's own success
  /// callback.
  ///
  /// Keyed per-account: switching from account A to account B with an
  /// IDENTICAL contact list must still upload once for B — the old single
  /// fixed key had no account dimension, so an export that happened to
  /// hash-match A's last upload was skipped for B even though B's vault
  /// has nothing in it.
  private func shouldUpload(digest: String, accountId: String) -> Bool {
    UserDefaults.standard.string(forKey: Self.hashKey(for: accountId)) != digest
  }

  // TODO: Migrate to Rust uploadEncryptedFile() — requires encrypting chunks to
  // temp files and calling the Rust upload function instead of the Swift HTTP
  // uploader. NativeBackupEngine already demonstrates the pattern. For now this
  // continues using the legacy Swift uploader which still works correctly.
  private func upload(data: Data, fileName: String, mimeType: String, token: String, accountId: String, digest: String) {
    guard let serverBaseURL else {
      RuntimeTrace.event("backup.contacts.upload_aborted", ["reason": "missing_server_url"])
      NSLog("[BeebeebBackup] contacts upload aborted: serverURL not configured in keychain (sign in again to set)")
      return
    }
    guard let parentFolderId, !parentFolderId.isEmpty else {
      RuntimeTrace.event("backup.contacts.upload_aborted", ["reason": "missing_parent_folder"])
      NSLog("[BeebeebBackup] contacts upload aborted: backup destination folder not configured")
      return
    }
    NativeEncryptedBackupUploader.shared.upload(
      plaintext: data,
      fileName: fileName,
      mimeType: mimeType,
      parentFolderId: parentFolderId,
      authToken: token,
      serverBaseURL: serverBaseURL,
      accountId: accountId
    ) { result in
      switch result {
      case .success:
        self.recordUploadSuccess(digest: digest, accountId: accountId)
        RuntimeTrace.event("backup.contacts.upload_success")
        NSLog("[BeebeebBackup] contacts upload succeeded")
      case .failure(let error):
        RuntimeTrace.event("backup.contacts.upload_failed", ["error": error.localizedDescription])
        NSLog("[BeebeebBackup] contacts upload failed: \(error.localizedDescription)")
      }
    }
  }
}
