import Foundation
import Contacts

final class ContactsBackupManager {
  static let shared = ContactsBackupManager()

  private var authToken: String?

  private var serverBaseURL: String {
    UserDefaults.standard.string(forKey: "io.beebeeb.serverURL") ?? "http://localhost:3001"
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

  func enable(authToken: String) {
    self.authToken = authToken
    CNContactStore().requestAccess(for: .contacts) { [weak self] granted, _ in
      guard granted else { return }
      self?.backup()
    }
  }

  func disable() {
    authToken = nil
  }

  func backup() {
    guard let token = authToken else { return }
    DispatchQueue.global(qos: .background).async { [weak self] in
      guard let self else { return }
      do {
        let vCardData = try self.exportContacts()
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

  private func upload(data: Data, fileName: String, mimeType: String, token: String) {
    // Attempt encryption — wrapped; BeebeebCore.xcframework not yet linked.
    var encryptedData = data
    if let masterKey = try? KeychainManager.load(label: "master") {
      _ = masterKey // TODO: encrypt via Rust when xcframework is linked
    }

    guard let url = URL(string: "\(serverBaseURL)/api/v1/files/upload") else { return }
    let boundary = "beebeeb-\(UUID().uuidString)"
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

    let crlf = "\r\n"
    let metadataJSON = """
    {"name_encrypted":"\(fileName)","mime_type":"\(mimeType)","size_bytes":\(encryptedData.count)}
    """
    var body = Data()
    body.append("--\(boundary)\(crlf)Content-Disposition: form-data; name=\"metadata\"\(crlf)\(crlf)\(metadataJSON)\(crlf)".utf8Data)
    body.append("--\(boundary)\(crlf)Content-Disposition: form-data; name=\"chunk_0\"; filename=\"\(fileName)\"\(crlf)Content-Type: \(mimeType)\(crlf)\(crlf)".utf8Data)
    body.append(encryptedData)
    body.append("\(crlf)--\(boundary)--\(crlf)".utf8Data)
    request.httpBody = body

    URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
  }
}

private extension String {
  var utf8Data: Data { data(using: .utf8) ?? Data() }
}
