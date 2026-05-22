import Foundation
import Contacts
import CryptoKit

final class ContactsBackupManager {
  static let shared = ContactsBackupManager()

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
    CNContactStore().requestAccess(for: .contacts) { [weak self] granted, _ in
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
  }

  func backup() {
    guard let token = authToken else { return }
    DispatchQueue.global(qos: .background).async { [weak self] in
      guard let self else { return }
      do {
        let vCardData = try self.exportContacts()
        guard self.shouldUpload(data: vCardData, stateKey: "io.beebeeb.contactsBackupLastHash") else { return }
        self.upload(data: vCardData, fileName: "contacts.vcf", mimeType: "text/vcard", token: token)
      } catch {
        // Contact export failed — permissions not granted or empty contacts
      }
    }
  }

  private func exportContacts() throws -> Data {
    let store = CNContactStore()
    let keys: [CNKeyDescriptor] = [CNContactVCardSerialization.descriptorForRequiredKeys()]
    let request = CNContactFetchRequest(keysToFetch: keys)
    var contacts: [CNContact] = []
    try store.enumerateContacts(with: request) { contact, _ in
      contacts.append(contact)
    }
    return try CNContactVCardSerialization.data(with: contacts)
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
      NSLog("[BeebeebBackup] contacts upload aborted: serverURL not configured in keychain (sign in again to set)")
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
      if case .failure(let error) = result {
        NSLog("[BeebeebBackup] contacts upload failed: \(error.localizedDescription)")
      }
    }
  }
}
