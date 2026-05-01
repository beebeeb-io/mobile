import Foundation
import EventKit

final class CalendarBackupManager {
  static let shared = CalendarBackupManager()

  private let store = EKEventStore()
  private var authToken: String?

  private var serverBaseURL: String {
    UserDefaults.standard.string(forKey: "io.beebeeb.serverURL") ?? "http://localhost:3001"
  }

  private init() {}

  func enable(authToken: String) {
    self.authToken = authToken
    requestAccessAndBackup()
  }

  func disable() {
    authToken = nil
  }

  func backup() {
    guard let token = authToken else { return }
    DispatchQueue.global(qos: .background).async { [weak self] in
      guard let self else { return }
      let ical = self.exportICal()
      guard let data = ical.data(using: .utf8) else { return }
      self.upload(data: data, token: token)
    }
  }

  private func requestAccessAndBackup() {
    if #available(iOS 17.0, *) {
      store.requestFullAccessToEvents { [weak self] granted, _ in
        guard granted else { return }
        self?.backup()
      }
    } else {
      store.requestAccess(to: .event) { [weak self] granted, _ in
        guard granted else { return }
        self?.backup()
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

  private func icalEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
     .replacingOccurrences(of: "\n", with: "\\n")
     .replacingOccurrences(of: ";", with: "\\;")
     .replacingOccurrences(of: ",", with: "\\,")
  }

  private func upload(data: Data, token: String) {
    // Attempt encryption — wrapped; BeebeebCore.xcframework not yet linked.
    var encryptedData = data
    if let masterKey = try? KeychainManager.load(label: "master") {
      _ = masterKey // TODO: encrypt via Rust when xcframework is linked
    }

    let fileName = "calendar.ics"
    let mimeType = "text/calendar"
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

private extension Data {
  mutating func append(_ string: String) {
    if let d = string.data(using: .utf8) { append(d) }
  }
}
