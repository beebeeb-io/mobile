import Foundation
import Contacts
import CryptoKit

final class ContactsBackupManager {
  static let shared = ContactsBackupManager()
  private static let lastHashKey = "io.beebeeb.contactsBackupLastHash"
  private static let lastScanAtKey = "io.beebeeb.contactsBackupLastScanAt"
  private static let lastScanCountKey = "io.beebeeb.contactsBackupLastScanCount"
  private static let lastUploadAtKey = "io.beebeeb.contactsBackupLastUploadAt"

  private var authToken: String?
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
      guard self?.authToken != nil else { return }
      self?.backup()
    }
  }

  func enable(authToken: String, runNow: Bool = true) {
    self.authToken = authToken
    RuntimeTrace.event("backup.contacts.enable", ["runNow": runNow])
    CNContactStore().requestAccess(for: .contacts) { [weak self] granted, _ in
      RuntimeTrace.event("backup.contacts.permission", ["granted": granted])
      guard granted else { return }
      if runNow {
        self?.backup()
      }
    }
  }

  func disable() {
    authToken = nil
  }

  func configure(parentFolderId: String?) {
    self.parentFolderId = parentFolderId
    RuntimeTrace.event("backup.contacts.configure", [
      "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
    ])
  }

  func backup() {
    guard let token = authToken else { return }
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
        guard self.shouldUpload(data: export.data, stateKey: Self.lastHashKey) else {
          RuntimeTrace.event("backup.contacts.skipped_unchanged")
          return
        }
        self.upload(data: export.data, fileName: "contacts.vcf", mimeType: "text/vcard", token: token)
      } catch {
        RuntimeTrace.event("backup.contacts.failed", ["error": error.localizedDescription])
        // Contact export failed — permissions not granted or empty contacts
      }
    }
  }

  func status() -> [String: Any] {
    let defaults = UserDefaults.standard
    let hasKnownBackupState =
      defaults.string(forKey: Self.lastHashKey) != nil ||
      defaults.string(forKey: Self.lastScanAtKey) != nil ||
      defaults.string(forKey: Self.lastUploadAtKey) != nil
    return [
      "lastScanAt": defaults.string(forKey: Self.lastScanAtKey) as Any? ?? NSNull(),
      "lastScanCount": defaults.integer(forKey: Self.lastScanCountKey),
      "lastUploadAt": defaults.string(forKey: Self.lastUploadAtKey) as Any? ?? NSNull(),
      "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
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

  private func recordUploadSuccess() {
    let now = ISO8601DateFormatter().string(from: Date())
    UserDefaults.standard.set(now, forKey: Self.lastUploadAtKey)
  }

  private func shouldUpload(data: Data, stateKey: String) -> Bool {
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard UserDefaults.standard.string(forKey: stateKey) != digest else { return false }
    UserDefaults.standard.set(digest, forKey: stateKey)
    return true
  }

  // TODO: Migrate to Rust uploadEncryptedFile() — requires encrypting chunks to
  // temp files and calling the Rust upload function instead of the Swift HTTP
  // uploader. NativeBackupEngine already demonstrates the pattern. For now this
  // continues using the legacy Swift uploader which still works correctly.
  private func upload(data: Data, fileName: String, mimeType: String, token: String) {
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
      serverBaseURL: serverBaseURL
    ) { result in
      switch result {
      case .success:
        self.recordUploadSuccess()
        RuntimeTrace.event("backup.contacts.upload_success")
        NSLog("[BeebeebBackup] contacts upload succeeded")
      case .failure(let error):
        RuntimeTrace.event("backup.contacts.upload_failed", ["error": error.localizedDescription])
        NSLog("[BeebeebBackup] contacts upload failed: \(error.localizedDescription)")
      }
    }
  }
}
