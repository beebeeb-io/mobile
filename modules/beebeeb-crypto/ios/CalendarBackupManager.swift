import Foundation
import EventKit
import CryptoKit

final class CalendarBackupManager {
  static let shared = CalendarBackupManager()
  private static let lastHashPrefix = "io.beebeeb.calendarBackupLastHash."
  private static let lastScanAtKey = "io.beebeeb.calendarBackupLastScanAt"
  private static let lastScanCountKey = "io.beebeeb.calendarBackupLastScanCount"
  private static let lastUploadAtKey = "io.beebeeb.calendarBackupLastUploadAt"

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

  // Server URL is keychain-only (task 0430). No localhost fallback (task 0442) —
  // workspace rule forbids defaulting to dev hosts in production code paths.
  // Returns nil when the keychain slot is empty; the upload site guards and
  // aborts cleanly.
  private var serverBaseURL: String? {
    KeychainManager.loadString(key: "io.beebeeb.serverURL")
  }

  private init() {}

  func enable(authToken: String, runNow: Bool = true) {
    self.authToken = authToken
    RuntimeTrace.event("backup.calendar.enable", ["runNow": runNow])
    requestAccessAndBackup(runNow: runNow)
  }

  func disable() {
    authToken = nil
  }

  /// Task 0819: self-heal after the server-side backup copy is gone. Clears the
  /// scan/upload timestamps AND EVERY per-calendar SHA dedup digest (all keys
  /// under `lastHashPrefix`) so the next run RE-UPLOADS each calendar instead of
  /// being suppressed as "unchanged", and the status tile resets. Data-safe —
  /// only local UserDefaults bookkeeping is cleared; the calendars themselves and
  /// the configured parent folder are kept.
  func reset() {
    let defaults = UserDefaults.standard
    for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.lastHashPrefix) {
      defaults.removeObject(forKey: key)
    }
    defaults.removeObject(forKey: Self.lastScanAtKey)
    defaults.removeObject(forKey: Self.lastScanCountKey)
    defaults.removeObject(forKey: Self.lastUploadAtKey)
    RuntimeTrace.event("backup.calendar.reset")
  }

  func configure(parentFolderId: String?) {
    self.parentFolderId = parentFolderId
    RuntimeTrace.event("backup.calendar.configure", [
      "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
    ])
  }

  func backup() {
    guard let token = authToken else { return }
    RuntimeTrace.event("backup.calendar.start")
    DispatchQueue.global(qos: .background).async { [weak self] in
      guard let self else { return }
      let calendars = self.store.calendars(for: .event)
      RuntimeTrace.event("backup.calendar.enumerated", ["calendarCount": calendars.count])
      let start = Calendar.current.date(byAdding: .year, value: -5, to: Date())!
      let end = Calendar.current.date(byAdding: .year, value: 2, to: Date())!
      var scannedEventCount = 0
      for cal in calendars {
        let predicate = self.store.predicateForEvents(withStart: start, end: end, calendars: [cal])
        let events = self.store.events(matching: predicate)
        scannedEventCount += events.count
        if events.isEmpty { continue }
        let ical = self.exportICal(calendar: cal, events: events)
        guard let data = ical.data(using: .utf8) else { continue }
        let stateKey = Self.lastHashPrefix + self.stateKeyComponent(for: cal.title)
        guard self.shouldUpload(data: data, stateKey: stateKey) else {
          RuntimeTrace.event("backup.calendar.skipped_unchanged", ["eventCount": events.count])
          continue
        }
        let fileName = self.safeFileName(cal.title) + ".ics"
        self.upload(data: data, fileName: fileName, token: token)
      }
      self.recordScan(count: scannedEventCount)
    }
  }

  func status() -> [String: Any] {
    let defaults = UserDefaults.standard
    let hasCalendarHash = defaults.dictionaryRepresentation().keys.contains { key in
      key.hasPrefix(Self.lastHashPrefix)
    }
    let hasKnownBackupState =
      hasCalendarHash ||
      defaults.string(forKey: Self.lastScanAtKey) != nil ||
      defaults.string(forKey: Self.lastUploadAtKey) != nil
    return [
      "lastScanAt": defaults.string(forKey: Self.lastScanAtKey) as Any? ?? NSNull(),
      "lastScanCount": defaults.integer(forKey: Self.lastScanCountKey),
      "lastUploadAt": defaults.string(forKey: Self.lastUploadAtKey) as Any? ?? NSNull(),
      "hasParentFolder": !(parentFolderId?.isEmpty ?? true),
      // Task 0819: the category folder id (Calendar/) so the reconcile can detect
      // it's gone from /files/index and trigger a self-heal reset.
      "parentFolderId": parentFolderId as Any? ?? NSNull(),
      "hasKnownBackupState": hasKnownBackupState
    ]
  }

  private func requestAccessAndBackup(runNow: Bool) {
    if #available(iOS 17.0, *) {
      store.requestFullAccessToEvents { [weak self] granted, _ in
        RuntimeTrace.event("backup.calendar.permission", ["granted": granted])
        guard granted else { return }
        if runNow {
          self?.backup()
        }
      }
    } else {
      store.requestAccess(to: .event) { [weak self] granted, _ in
        RuntimeTrace.event("backup.calendar.permission", ["granted": granted])
        guard granted else { return }
        if runNow {
          self?.backup()
        }
      }
    }
  }

  /// Build an RFC 5545 iCalendar file for a single EKCalendar. Per task 0439
  /// (with audit in the task spec), this implementation now:
  /// - emits one file per calendar instead of a merged file
  /// - includes the REQUIRED `DTSTAMP` on every VEVENT (RFC 5545 §3.6.1)
  /// - omits the bogus `BEGIN:VTIMEZONE / TZID:<calendar title>` block — events
  ///   are already in UTC (`yyyyMMdd'T'HHmmss'Z'`), so no VTIMEZONE is needed
  /// - emits `METHOD:PUBLISH` + `X-WR-CALNAME` for client interop
  /// - applies 75-octet line folding (RFC 5545 §3.1) on every output line
  private func exportICal(calendar: EKCalendar, events: [EKEvent]) -> String {
    let utcFmt = DateFormatter()
    utcFmt.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    utcFmt.timeZone = TimeZone(identifier: "UTC")
    let allDayFmt = DateFormatter()
    allDayFmt.dateFormat = "yyyyMMdd"
    allDayFmt.timeZone = TimeZone(identifier: "UTC")
    let dtstampNow = utcFmt.string(from: Date())

    var lines: [String] = []
    lines.append("BEGIN:VCALENDAR")
    lines.append("VERSION:2.0")
    lines.append("PRODID:-//Beebeeb//EN")
    lines.append("CALSCALE:GREGORIAN")
    lines.append("METHOD:PUBLISH")
    lines.append("X-WR-CALNAME:\(icalEscape(calendar.title))")

    for event in events {
      lines.append("BEGIN:VEVENT")
      lines.append("UID:\(event.eventIdentifier ?? UUID().uuidString)")
      lines.append("DTSTAMP:\(dtstampNow)")
      lines.append("SUMMARY:\(icalEscape(event.title ?? ""))")

      if event.isAllDay {
        lines.append("DTSTART;VALUE=DATE:\(allDayFmt.string(from: event.startDate))")
        lines.append("DTEND;VALUE=DATE:\(allDayFmt.string(from: event.endDate))")
      } else {
        lines.append("DTSTART:\(utcFmt.string(from: event.startDate))")
        lines.append("DTEND:\(utcFmt.string(from: event.endDate))")
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
    return lines.map { foldLine($0) }.joined(separator: "\r\n")
  }

  /// RFC 5545 §3.1 line folding: lines MUST NOT exceed 75 octets. Long lines
  /// are split between any two characters by inserting CRLF + a single space
  /// (or HTAB). The continuation's leading space is part of the 75-octet
  /// limit, so continuation chunks carry up to 74 octets of content.
  ///
  /// Splits on Unicode scalar boundaries so a multi-byte UTF-8 sequence is
  /// never sliced — a literal byte-count split would corrupt characters like
  /// emoji or accented letters that legitimately appear in calendar notes.
  private func foldLine(_ line: String) -> String {
    if line.utf8.count <= 75 { return line }

    var result = ""
    var currentChunk = ""
    var currentBytes = 0
    var isFirstChunk = true

    for scalar in line.unicodeScalars {
      let scalarBytes = String(scalar).utf8.count
      let chunkLimit = isFirstChunk ? 75 : 74
      if currentBytes + scalarBytes > chunkLimit {
        if isFirstChunk {
          result = currentChunk
          isFirstChunk = false
        } else {
          result += "\r\n " + currentChunk
        }
        currentChunk = String(scalar)
        currentBytes = scalarBytes
      } else {
        currentChunk += String(scalar)
        currentBytes += scalarBytes
      }
    }

    if isFirstChunk {
      result = currentChunk
    } else if !currentChunk.isEmpty {
      result += "\r\n " + currentChunk
    }
    return result
  }

  /// Sanitize a calendar title for use as a filename. The encrypted-name
  /// envelope ultimately wraps this, but the display name shown when the
  /// user downloads the .ics needs to be filesystem-safe.
  private func safeFileName(_ title: String) -> String {
    let invalid = CharacterSet(charactersIn: "/\\:?*\"<>|")
    let cleaned = title.components(separatedBy: invalid).joined(separator: "_")
    return cleaned.isEmpty ? "Calendar" : cleaned
  }

  /// Hash a calendar title to a stable ASCII-safe component for the
  /// per-calendar dedup key in UserDefaults. Calendar titles can contain
  /// any character; the SHA-256 hex keeps the key well-formed regardless.
  private func stateKeyComponent(for title: String) -> String {
    let digest = SHA256.hash(data: Data(title.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
  }

  private func shouldUpload(data: Data, stateKey: String) -> Bool {
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard UserDefaults.standard.string(forKey: stateKey) != digest else { return false }
    UserDefaults.standard.set(digest, forKey: stateKey)
    return true
  }

  private func recordScan(count: Int) {
    let now = ISO8601DateFormatter().string(from: Date())
    let defaults = UserDefaults.standard
    defaults.set(now, forKey: Self.lastScanAtKey)
    defaults.set(count, forKey: Self.lastScanCountKey)
    RuntimeTrace.event("backup.calendar.scan_recorded", [
      "eventCount": count,
      "lastScanAt": now
    ])
  }

  private func recordUploadSuccess() {
    let now = ISO8601DateFormatter().string(from: Date())
    UserDefaults.standard.set(now, forKey: Self.lastUploadAtKey)
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
  private func upload(data: Data, fileName: String, token: String) {
    guard let serverBaseURL else {
      RuntimeTrace.event("backup.calendar.upload_aborted", ["reason": "missing_server_url"])
      NSLog("[BeebeebBackup] calendar upload aborted: serverURL not configured in keychain (sign in again to set)")
      return
    }
    guard let parentFolderId, !parentFolderId.isEmpty else {
      RuntimeTrace.event("backup.calendar.upload_aborted", ["reason": "missing_parent_folder"])
      NSLog("[BeebeebBackup] calendar upload of \(fileName) aborted: backup destination folder not configured")
      return
    }
    let mimeType = "text/calendar"
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
        RuntimeTrace.event("backup.calendar.upload_success")
        NSLog("[BeebeebBackup] calendar upload succeeded")
      case .failure(let error):
        RuntimeTrace.event("backup.calendar.upload_failed", ["error": error.localizedDescription])
        NSLog("[BeebeebBackup] calendar upload of \(fileName) failed: \(error.localizedDescription)")
      }
    }
  }
}
