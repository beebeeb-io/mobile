import Foundation
import os.log

enum RuntimeTrace {
  private static let logger = Logger(subsystem: "io.beebeeb.runtime", category: "trace")
  private static let lock = NSLock()
  private static var sequence = 0

  static func event(_ name: String, _ fields: [String: Any] = [:]) {
    guard isEnabled else { return }
    lock.lock()
    sequence += 1
    let seq = sequence
    lock.unlock()

    var payload: [String: Any] = [
      "seq": seq,
      "at": ISO8601DateFormatter().string(from: Date()),
      "name": name,
    ]
    for (key, value) in fields {
      payload[key] = sanitize(key: key, value: value)
    }

    let json: String
    if JSONSerialization.isValidJSONObject(payload),
       let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let encoded = String(data: data, encoding: .utf8) {
      json = encoded
    } else {
      json = "{\"name\":\"\(name)\"}"
    }

    logger.info("\(json, privacy: .public)")
    NSLog("[BeebeebRuntimeTrace] \(json)")
  }

  private static var isEnabled: Bool {
    #if DEBUG
    return true
    #else
    return ProcessInfo.processInfo.environment["BEEBEEB_RUNTIME_TRACE"] == "1" ||
      UserDefaults.standard.bool(forKey: "io.beebeeb.runtimeTrace")
    #endif
  }

  private static func sanitize(key: String, value: Any) -> Any {
    let lower = key.lowercased()
    if lower.contains("token") ||
       lower.contains("password") ||
       lower.contains("secret") ||
       lower.contains("keybytes") ||
       lower.contains("masterkey") ||
       lower.contains("ciphertext") ||
       lower.contains("plaintext") {
      return "[redacted]"
    }
    if let data = value as? Data {
      return "[bytes:\(data.count)]"
    }
    if let string = value as? String, string.count > 180 {
      return "\(string.prefix(180))…"
    }
    if let array = value as? [Any] {
      return array.prefix(20).enumerated().map { sanitize(key: "\($0.offset)", value: $0.element) }
    }
    if let dict = value as? [String: Any] {
      var out: [String: Any] = [:]
      for (childKey, childValue) in dict.prefix(30) {
        out[childKey] = sanitize(key: childKey, value: childValue)
      }
      return out
    }
    return value
  }
}
