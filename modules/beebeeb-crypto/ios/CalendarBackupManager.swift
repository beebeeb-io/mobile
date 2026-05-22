import Foundation
import EventKit
import CryptoKit

final class CalendarBackupManager {
  static let shared = CalendarBackupManager()

  private let store = EKEventStore()
  private var authToken: String?
  private var parentFolderId: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.calendarBackupParentFolderId") }
    set {
      if let newValue, !newValue.isEmpty {
        UserDefaults.standard.set(newValue, forKey: "io.beebeeb.calendarBackupParentFolderId")
      } else {
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.calendarBackupParentFolderId")
      }
    }
  }

  private var serverBaseURL: String {
    // Server URL moved to Keychain (task 0430); see PhotoBackupManager note.
    KeychainManager.loadString(key: "io.beebeeb.serverURL") ?? "http://localhost:3001"
  }

  private init() {}

  func enable(authToken: String, runNow: Bool = true) {
    self.authToken = authToken
    requestAccessAndBackup(runNow: runNow)
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
      let ical = self.exportICal()
      guard let data = ical.data(using: .utf8) else { return }
      guard self.shouldUpload(data: data, stateKey: "io.beebeeb.calendarBackupLastHash") else { return }
      self.upload(data: data, token: token)
    }
  }

  private func requestAccessAndBackup(runNow: Bool) {
    if #available(iOS 17.0, *) {
      store.requestFullAccessToEvents { [weak self] granted, _ in
        guard granted else { return }
        if runNow {
          self?.backup()
        }
      }
    } else {
      store.requestAccess(to: .event) { [weak self] granted, _ in
        guard granted else { return }
        if runNow {
          self?.backup()
        }
      }
    }
  }

  private func exportICal() -> String {
    let calendars = store.calendars(for: .event)
    let start = Calendar.current.date(byAdding: .year, value: -5, to: Date())!
    let end = Calendar.current.date(byAdding: .year, value: 2, to: Date())!
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: predicate)

    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Beebeeb//EN", "CALSCALE:GREGORIAN"]

    for calendar in calendars {
      lines += ["BEGIN:VTIMEZONE", "TZID:\(icalEscape(calendar.title))", "END:VTIMEZONE"]
    }

    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime]

    for event in events {
      lines.append("BEGIN:VEVENT")
      lines.append("UID:\(event.eventIdentifier ?? UUID().uuidString)")
      lines.append("SUMMARY:\(icalEscape(event.title ?? ""))")

      if event.isAllDay {
        let df = DateFormatter()
        df.dateFormat = "yyyyMMdd"
        lines.append("DTSTART;VALUE=DATE:\(df.string(from: event.startDate))")
        lines.append("DTEND;VALUE=DATE:\(df.string(from: event.endDate))")
      } else {
        let df = DateFormatter()
        df.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        df.timeZone = TimeZone(identifier: "UTC")
        lines.append("DTSTART:\(df.string(from: event.startDate))")
        lines.append("DTEND:\(df.string(from: event.endDate))")
      }

      if let notes = event.notes, !notes.isEmpty {
        lines.append("DESCRIPTION:\(icalEscape(notes))")
      }
      if let location = event.location, !location.isEmpty {
        lines.append("LOCATION:\(icalEscape(location))")
      }
      lines.append("END:VEVENT")
    }

    lines.append("END:VCALENDAR")
    return lines.joined(separator: "\r\n")
  }

  private func shouldUpload(data: Data, stateKey: String) -> Bool {
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard UserDefaults.standard.string(forKey: stateKey) != digest else { return false }
    UserDefaults.standard.set(digest, forKey: stateKey)
    return true
  }

  private func icalEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\n", with: "\\n")
     .replacingOccurrences(of: ";", with: "\\;")
     .replacingOccurrences(of: ",", with: "\\,")
  }

  // TODO: Migrate to Rust uploadEncryptedFile() — requires encrypting chunks to
  // temp files and calling the Rust upload function instead of the Swift HTTP
  // uploader. NativeBackupEngine already demonstrates the pattern. For now this
  // continues using the legacy Swift uploader which still works correctly.
  private func upload(data: Data, token: String) {
    let fileName = "calendar.ics"
    let mimeType = "text/calendar"
    NativeEncryptedBackupUploader.shared.upload(
      plaintext: data,
      fileName: fileName,
      mimeType: mimeType,
      parentFolderId: parentFolderId,
      authToken: token,
      serverBaseURL: serverBaseURL
    ) { result in
      if case .failure(let error) = result {
        NSLog("[BeebeebBackup] calendar upload failed: \(error.localizedDescription)")
      }
    }
  }
}
