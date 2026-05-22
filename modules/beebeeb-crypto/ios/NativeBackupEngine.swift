import AVFoundation
import ActivityKit
import Foundation
import Photos
import SDWebImage
import SDWebImageWebPCoder
import SQLite3
import UIKit
import UniformTypeIdentifiers
import UserNotifications
import WidgetKit
#if os(iOS)
import BackgroundTasks
import Network
#endif

private let backupAppGroupIdentifier = "group.io.beebeeb.shared"
private let backupStatusFileName = "backup-status.json"
private let backupReminderIdentifier = "io.beebeeb.backup.open-app-reminder"
private let backupReminderLastSentKey = "io.beebeeb.backupNotifications.openAppReminderLastSentAt"
private let backupReminderCooldownSeconds: TimeInterval = 24 * 60 * 60
private let backupReminderDelaySeconds: TimeInterval = 15 * 60
private let stagedBackupDirectoryName = "NativeBackupStaging"
private let minimumFreeBytesAfterStaging: Int64 = 2 * 1024 * 1024 * 1024
private let maxStagedBackupBytes: Int64 = 3 * 1024 * 1024 * 1024

@available(iOS 16.1, *)
struct BeebeebBackupActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var total: Int
    var completed: Int
    var pending: Int
    var waitingToEncrypt: Int
    var encryptedPendingUpload: Int
    var uploading: Int
    var failed: Int
    var state: String
    var reason: String
    var updatedAt: Date
  }

  var startedAt: Date
}

private struct BackupStatusPayload: Codable {
  var total: Int
  var completed: Int
  var pending: Int
  var waitingToEncrypt: Int
  var encryptedPendingUpload: Int
  var uploading: Int
  var inProgress: Int
  var failed: Int
  var bytesUploaded: Int64
  var bytesTotal: Int64
  var state: String
  var reason: String
  var lastBackupAt: String?
  var lastChangeAt: String
  var updatedAt: String
}

private struct BackupWorkBreakdown {
  var waitingToEncrypt: Int
  var encryptedPendingUpload: Int
  var uploading: Int
}

// MARK: - Types

enum BackupError: LocalizedError {
  case assetNotFound
  case assetLoadFailed
  case databaseUnavailable
  case noMasterKey
  case notConfigured
  case invalidServerURL
  case invalidResponse
  case httpStatus(Int, String)
  case jsonEncoding
  case encryptionFailed(String)

  var errorDescription: String? {
    switch self {
    case .assetNotFound: return "Photo asset not found in library"
    case .assetLoadFailed: return "Failed to load photo data from library"
    case .databaseUnavailable: return "Backup database unavailable"
    case .noMasterKey: return "Master key not available — sign in required"
    case .notConfigured: return "Backup engine not configured (missing token or API URL)"
    case .invalidServerURL: return "Invalid server URL for backup"
    case .invalidResponse: return "Invalid server response"
    case .httpStatus(let code, let body):
      return body.isEmpty ? "HTTP \(code)" : "HTTP \(code): \(body)"
    case .jsonEncoding: return "JSON encoding failed"
    case .encryptionFailed(let msg): return "Encryption failed: \(msg)"
    }
  }
}

/// Row from the backup_assets SQLite table.
struct BackupAssetRow {
  let localAssetId: String
  let remoteFileId: String?
  let assetType: String
  let contentHash: String
  let fileSize: Int64
  let createdAt: String
  let retryCount: Int
  let errorMessage: String?
  let filename: String? // Not stored in DB — resolved from PHAsset at upload time
  let stagedFileId: String?
  let stagedNameEncrypted: String?
  let stagedMimeType: String?
  let stagedIsMedia: Bool
  let stagedOriginalSize: Int64
  let stagedChunkCount: Int
  let stagedDir: String?
}

private struct BackgroundChunkTaskDescription: Codable {
  let localAssetId: String
  let serverFileId: String
  let chunkIndex: Int
}

private struct StagedChunkRow {
  let index: Int
  let path: String
}

private enum ExistingUploadDisposition {
  case resumable
  case alreadyCompleted
  case missingRemote
}

private enum BackupPacingMode: String {
  case foregroundActive
  case foregroundIdle
  case background
  case lowPower
  case thermalPressure
  case serverBackoff

  var batchLimit: Int {
    switch self {
    case .foregroundActive, .lowPower, .thermalPressure, .serverBackoff:
      return 1
    case .foregroundIdle:
      return 2
    case .background:
      return 3
    }
  }

  var delayNanoseconds: UInt64 {
    switch self {
    case .foregroundActive:
      return 2_000_000_000
    case .foregroundIdle:
      return 750_000_000
    case .background:
      return 150_000_000
    case .lowPower, .thermalPressure, .serverBackoff:
      return 5_000_000_000
    }
  }
}

// MARK: - NativeBackupEngine

/// Native Swift backup engine for camera-roll backup.
///
/// Architecture:
/// - PHPhotoLibraryChangeObserver for real-time asset detection
/// - Foreground-friendly single-upload pipeline
/// - Rust encrypt via MasterKeyHandle -> FileKeyHandle -> encryptChunk (chunks written to temp files)
/// - Rust `uploadEncryptedFile()` from beebeeb-upload crate handles init/chunk-upload/complete
/// - Shared SQLite database (backup_assets) with JS UI layer via WAL mode
/// - Expo EventEmitter bridge for progress -> React
///
/// Encryption uses the MasterKeyHandle -> FileKeyHandle -> encryptChunk path,
/// writing encrypted chunks to temp files. The Rust `uploadEncryptedFile()`
/// function from the beebeeb-upload crate then handles the full upload
/// protocol (init session, upload chunks, complete) in a single blocking call.
final class NativeBackupEngine: NSObject {
  static let shared = NativeBackupEngine()

  private let liveActivityRequestQueue = DispatchQueue(label: "io.beebeeb.backup.live-activity")
  private var liveActivityRequestInFlight = false

  private func perfLog(_ event: String, _ fields: [String: CustomStringConvertible] = [:]) {
    let suffix = fields
      .map { "\($0.key)=\($0.value)" }
      .sorted()
      .joined(separator: " ")
    if suffix.isEmpty {
      NSLog("[BeebeebPerf] backup.native.\(event)")
    } else {
      NSLog("[BeebeebPerf] backup.native.\(event) \(suffix)")
    }
  }

  private func isoString(from date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
  }

  private func jsonValue<T>(_ value: T?) -> Any {
    guard let value else { return NSNull() }
    return value
  }

  private func nowMs() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }

  private func normalizedCreatedAt(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let value = Double(trimmed), value.isFinite {
      let seconds = value > 10_000_000_000 ? value / 1000 : value
      return isoString(from: Date(timeIntervalSince1970: seconds))
    }
    if let date = ISO8601DateFormatter().date(from: trimmed) {
      return isoString(from: date)
    }
    return isoString(from: Date())
  }

  // MARK: - Private state

  private let queue = DispatchQueue(label: "io.beebeeb.backup.engine", qos: .utility)
  private let dbQueue = DispatchQueue(label: "io.beebeeb.backup.engine.db", qos: .utility)
  private var backgroundSession: URLSession!
  private var metadataSession: URLSession!
  private var db: OpaquePointer?
  private var masterKeyHandle: MasterKeyHandle?
  private var isRunning = false
  private var isPaused = false
  private var uploadTaskMap: [Int: String] = [:] // URLSessionTask.taskIdentifier -> localAssetId
  private var drainTask: Task<Void, Never>?
  private var drainLoopGeneration = 0
  private var pendingDrainWakeReason: String?
  private let batchProcessingQueue = DispatchQueue(label: "io.beebeeb.backup.engine.batch", qos: .utility)
  private var batchProcessingActive = false
  private var currentFetchResult: PHFetchResult<PHAsset>?
  private var photoObserverRegistered = false
  private var isBackgroundTaskActive = false
  private var isBackgroundGraceActive = false
  private var backgroundGraceTask: UIBackgroundTaskIdentifier = .invalid
  private var chunkUploadContinuations: [Int: CheckedContinuation<Void, Error>] = [:]
  #if os(iOS)
  private var networkMonitor: NWPathMonitor?
  private var isNetworkAvailable = true
  #endif

  // Chunk size matching existing uploader (4 MB)
  private let chunkSize = 4 * 1024 * 1024
  private let maxConcurrentUploads = 1
  private let batchLimit = 12

  // Backoff state
  private var consecutiveFailures = 0
  private var backoffUntil: Date?

  static let bgTaskIdentifier = "io.beebeeb.app.native-backup"
  static let bgSessionIdentifier = "io.beebeeb.backup"

  // MARK: - Configuration (set by JS before calling start)

  var parentFolderId: String? {
    get { UserDefaults.standard.string(forKey: "io.beebeeb.photoBackupParentFolderId") }
    set {
      if let newValue, !newValue.isEmpty {
        UserDefaults.standard.set(newValue, forKey: "io.beebeeb.photoBackupParentFolderId")
      } else {
        UserDefaults.standard.removeObject(forKey: "io.beebeeb.photoBackupParentFolderId")
      }
    }
  }

  // Backup auth token and server URL are persisted in the Keychain (not
  // UserDefaults) so they do not propagate via unencrypted iTunes / iCloud
  // backups. See `KeychainManager.storeString` for the storage class and
  // task 0430 for context. `loadString` performs a one-time on-demand
  // migration from UserDefaults the first time it's called after upgrade.
  var token: String? {
    get { KeychainManager.loadString(key: "io.beebeeb.backupToken") }
    set {
      if let value = newValue, !value.isEmpty {
        try? KeychainManager.storeString(value, key: "io.beebeeb.backupToken")
      } else {
        KeychainManager.deleteString(key: "io.beebeeb.backupToken")
      }
    }
  }

  var apiBaseUrl: String? {
    get { KeychainManager.loadString(key: "io.beebeeb.serverURL") }
    set {
      if let value = newValue, !value.isEmpty {
        try? KeychainManager.storeString(value, key: "io.beebeeb.serverURL")
      } else {
        KeychainManager.deleteString(key: "io.beebeeb.serverURL")
      }
    }
  }

  // MARK: - Progress (thread-safe via atomic reads from main queue)

  private(set) var totalAssets = 0
  private(set) var completedAssets = 0
  private(set) var failedAssets = 0
  private(set) var inProgressAssets = 0
  private(set) var bytesUploaded: Int64 = 0
  private(set) var bytesTotal: Int64 = 0

  // MARK: - Callbacks

  /// Progress callback invoked on each asset completion. Called on arbitrary queue.
  var onProgress: ((_ total: Int, _ completed: Int, _ failed: Int) -> Void)?

  /// Per-file status callback.
  var onFileStatus: ((_ assetId: String, _ status: String, _ filename: String?, _ error: String?) -> Void)?

  /// Completion callback when a batch finishes.
  var onBatchComplete: ((_ uploaded: Int, _ failed: Int, _ duration: TimeInterval) -> Void)?

  // MARK: - Init

  private override init() {
    super.init()
    setupBackgroundSession()
    setupMetadataSession()
    dbQueue.sync { openDatabase() }
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  // MARK: - Backup Status Surfaces

  @objc private func handleAppDidEnterBackground() {
    beginBackgroundGraceIfNeeded()
    #if os(iOS)
    scheduleNextBackup()
    #endif
    updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")
    scheduleOpenAppReminderIfNeeded()
    logDiagnosticSnapshot(reason: "app_background")
  }

  @objc private func handleAppWillEnterForeground() {
    endBackgroundGrace()
    UNUserNotificationCenter.current().removePendingNotificationRequests(
      withIdentifiers: [backupReminderIdentifier]
    )
    UNUserNotificationCenter.current().removeDeliveredNotifications(
      withIdentifiers: [backupReminderIdentifier]
    )
    if isRunning, !isPaused, pendingUploadCount() > 0 {
      wakeDrainLoop(reason: "foreground")
    }
    updateBackupStatusSurfaces(reason: "App opened")
    logDiagnosticSnapshot(reason: "app_foreground")
  }

  private func pendingUploadCount() -> Int {
    dbQueue.sync {
      guard let db = db else { return 0 }
      return countWhere(
        db: db,
        condition: "status IN ('pending_upload', 'pending_reupload', 'staging', 'staged_upload', 'uploading') AND COALESCE(retry_count, 0) < 10"
      )
    }
  }

  private func beginBatchProcessing() -> Bool {
    batchProcessingQueue.sync {
      if batchProcessingActive { return false }
      batchProcessingActive = true
      return true
    }
  }

  private func finishBatchProcessing() {
    batchProcessingQueue.sync {
      batchProcessingActive = false
    }
  }

  private func backupWorkBreakdown() -> BackupWorkBreakdown {
    dbQueue.sync {
      guard let db = db else {
        return BackupWorkBreakdown(waitingToEncrypt: 0, encryptedPendingUpload: 0, uploading: 0)
      }
      return BackupWorkBreakdown(
        waitingToEncrypt: countWhere(
          db: db,
          condition: "status IN ('pending_upload', 'pending_reupload', 'staging') AND staged_file_id IS NULL AND COALESCE(retry_count, 0) < 10"
        ),
        encryptedPendingUpload: countWhere(
          db: db,
          condition: "status = 'staged_upload' AND staged_file_id IS NOT NULL AND COALESCE(retry_count, 0) < 10"
        ),
        uploading: countWhere(
          db: db,
          condition: "status = 'uploading' AND COALESCE(retry_count, 0) < 10"
        )
      )
    }
  }

  private func backupStatusCounts() -> [String: Int] {
    var counts: [String: Int] = [
      "pending_upload": 0,
      "staging": 0,
      "staged_upload": 0,
      "uploading": 0,
      "uploaded": 0,
      "pending_delete": 0,
      "pending_reupload": 0,
      "orphaned": 0,
      "remote_deleted": 0,
      "failed": 0,
      "local_missing": 0,
      "waiting_storage": 0,
      "waiting_unlock": 0,
      "waiting_wifi": 0,
      "failed_retryable": 0,
      "failed_terminal": 0,
    ]

    dbQueue.sync {
      guard let db = db else { return }
      var stmt: OpaquePointer?
      let sql = "SELECT status, COUNT(*) FROM backup_assets GROUP BY status"
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      defer { sqlite3_finalize(stmt) }
      while sqlite3_step(stmt) == SQLITE_ROW {
        guard let statusPointer = sqlite3_column_text(stmt, 0) else { continue }
        let status = String(cString: statusPointer)
        counts[status] = Int(sqlite3_column_int(stmt, 1))
      }
      counts["failed_retryable"] = countWhere(db: db, condition: "status = 'failed' AND COALESCE(retry_count, 0) < 10")
      counts["failed_terminal"] = countWhere(db: db, condition: "COALESCE(retry_count, 0) >= 10")
    }

    return counts
  }

  private func backupUploadChunkStatusCounts() -> [String: Int] {
    var counts: [String: Int] = [
      "pending": 0,
      "uploading": 0,
      "uploaded": 0,
      "failed": 0,
    ]

    dbQueue.sync {
      guard let db = db else { return }
      var stmt: OpaquePointer?
      let sql = "SELECT status, COUNT(*) FROM backup_upload_chunks GROUP BY status"
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
      defer { sqlite3_finalize(stmt) }
      while sqlite3_step(stmt) == SQLITE_ROW {
        guard let statusPointer = sqlite3_column_text(stmt, 0) else { continue }
        let status = String(cString: statusPointer)
        counts[status] = Int(sqlite3_column_int(stmt, 1))
      }
    }

    return counts
  }

  private func photoKitMissingCount() -> Int {
    dbQueue.sync {
      guard let db = db else { return 0 }
      return countWhere(
        db: db,
        condition: "status = 'local_missing' OR error_message LIKE '%Photo asset not found%' OR error_message LIKE '%not found in library%'"
      )
    }
  }

  private func applicationStateString() -> String {
    switch currentApplicationState() {
    case .active:
      return "active"
    case .inactive:
      return "inactive"
    case .background:
      return "background"
    @unknown default:
      return "unknown"
    }
  }

  private func photoAuthorizationStatusString() -> String {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .notDetermined:
      return "notDetermined"
    case .restricted:
      return "restricted"
    case .denied:
      return "denied"
    case .authorized:
      return "authorized"
    case .limited:
      return "limited"
    @unknown default:
      return "unknown"
    }
  }

  private func diagnosticAvailableBytes() -> Int64 {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    guard let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
          let available = values.volumeAvailableCapacityForImportantUsage else {
      return 0
    }
    return Int64(available)
  }

  private func diagnosticStagedBytesOnDisk() -> Int64 {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let root = base.appendingPathComponent(stagedBackupDirectoryName, isDirectory: true)
    guard FileManager.default.fileExists(atPath: root.path),
          let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
          ) else { return 0 }

    var total: Int64 = 0
    for case let fileURL as URL in enumerator {
      let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      total += Int64(size)
    }
    return total
  }

  func diagnosticSnapshot() -> [String: Any] {
    let progress = currentProgress()
    let pending = progress["pending"] as? Int ?? pendingUploadCount()
    let state = backupState(pending: pending)
    let freeBytes = diagnosticAvailableBytes()

    #if os(iOS)
    let networkAvailable = isNetworkAvailable
    #else
    let networkAvailable = true
    #endif

    return [
      "timestamp": isoString(from: Date()),
      "appState": applicationStateString(),
      "backup": [
        "publicState": state.state,
        "reason": state.reason,
        "isRunning": isRunning,
        "isPaused": isPaused,
        "drainTaskActive": drainTask != nil,
        "backgroundTaskActive": isBackgroundTaskActive,
        "backgroundGraceActive": isBackgroundGraceActive,
        "photoObserverRegistered": photoObserverRegistered,
        "pendingDrainWakeReason": jsonValue(pendingDrainWakeReason),
        "networkAvailable": networkAvailable,
        "backoffUntil": jsonValue(backoffUntil.map { isoString(from: $0) }),
        "consecutiveFailures": consecutiveFailures,
        "pacingMode": currentPacingMode().rawValue,
        "canRunNow": canExecuteBackupWorkNow(),
        "masterKeyHandleCached": masterKeyHandle != nil,
        "tokenConfigured": token?.isEmpty == false,
        "apiBaseUrlConfigured": apiBaseUrl?.isEmpty == false,
        "freeBytesAvailable": freeBytes,
        "minimumFreeBytesAfterStaging": minimumFreeBytesAfterStaging,
        "maxStagedBackupBytes": maxStagedBackupBytes,
        "stagedBytesOnDisk": diagnosticStagedBytesOnDisk(),
      ],
      "progress": progress,
      "queue": backupStatusCounts(),
      "uploadChunks": backupUploadChunkStatusCounts(),
      "photoKit": [
        "authorizationStatus": photoAuthorizationStatusString(),
        "currentFetchCount": jsonValue(currentFetchResult?.count),
        "missingCount": photoKitMissingCount(),
      ],
    ]
  }

  func logDiagnosticSnapshot(reason: String) {
    var snapshot = diagnosticSnapshot()
    snapshot["reason"] = reason
    if let data = try? JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]),
       let json = String(data: data, encoding: .utf8) {
      NSLog("[BeebeebDiagnostics] backup.snapshot \(json)")
    } else {
      NSLog("[BeebeebDiagnostics] backup.snapshot_failed reason=\(reason)")
    }
  }

  private func latestUploadedAt() -> String? {
    dbQueue.sync {
      guard let db = db else { return nil }
      var stmt: OpaquePointer?
      let sql = "SELECT uploaded_at FROM backup_assets WHERE uploaded_at IS NOT NULL ORDER BY uploaded_at DESC LIMIT 1"
      guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
      defer { sqlite3_finalize(stmt) }
      guard sqlite3_step(stmt) == SQLITE_ROW, sqlite3_column_type(stmt, 0) != SQLITE_NULL else {
        return nil
      }
      return String(cString: sqlite3_column_text(stmt, 0))
    }
  }

  private func backupState(pending: Int) -> (state: String, reason: String) {
    if isPaused {
      return ("pausedByUser", "Backup paused")
    }
    if pending > 0, !canExecuteBackupWorkNow() {
      return ("waitingForAppOpen", "Open Beebeeb to continue")
    }
    if !isRunning && pending > 0 {
      return ("idle", "Backup ready")
    }
    if failedAssets > 0 && pending == 0 && inProgressAssets == 0 {
      return ("needsAttention", "Some items need attention")
    }
    #if os(iOS)
    if !isNetworkAvailable && pending > 0 {
      return ("waitingForWifi", "Waiting for connection")
    }
    #endif
    if isRunning && (pending > 0 || inProgressAssets > 0) {
      if inProgressAssets > 0 || backupWorkBreakdown().uploading > 0 {
        return ("uploading", "Uploading")
      }
      return ("preparing", "Preparing backup")
    }
    if totalAssets > 0 && pending == 0 && inProgressAssets == 0 {
      return ("complete", "Backup complete")
    }
    return ("idle", "Nothing to back up")
  }

  private func makeBackupStatusPayload(reason explicitReason: String? = nil) -> BackupStatusPayload {
    refreshProgress()
    let pending = pendingUploadCount()
    let breakdown = backupWorkBreakdown()
    let state = backupState(pending: pending)
    let now = isoString(from: Date())
    return BackupStatusPayload(
      total: totalAssets,
      completed: completedAssets,
      pending: pending,
      waitingToEncrypt: breakdown.waitingToEncrypt,
      encryptedPendingUpload: breakdown.encryptedPendingUpload,
      uploading: breakdown.uploading,
      inProgress: inProgressAssets,
      failed: failedAssets,
      bytesUploaded: bytesUploaded,
      bytesTotal: bytesTotal,
      state: state.state,
      reason: explicitReason ?? state.reason,
      lastBackupAt: latestUploadedAt(),
      lastChangeAt: now,
      updatedAt: now
    )
  }

  private func updateBackupStatusSurfaces(reason: String? = nil) {
    let payload = makeBackupStatusPayload(reason: reason)
    writeBackupStatus(payload)
    updateLiveActivity(payload)
    if payload.pending == 0 {
      endBackgroundGrace()
    }
  }

  private func writeBackupStatus(_ payload: BackupStatusPayload) {
    guard let container = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: backupAppGroupIdentifier
    ) else { return }

    let url = container.appendingPathComponent(backupStatusFileName)
    do {
      let data = try JSONEncoder().encode(payload)
      try data.write(to: url, options: .atomic)
      WidgetCenter.shared.reloadTimelines(ofKind: "io.beebeeb.widget.storage")
    } catch {
      NSLog("[NativeBackupEngine] Failed to write backup status: \(error.localizedDescription)")
    }
  }

  private func scheduleOpenAppReminderIfNeeded() {
    let payload = makeBackupStatusPayload()
    guard payload.pending > 0, payload.state == "waitingForAppOpen" else { return }
    guard UserDefaults.standard.object(forKey: "io.beebeeb.backupNotifications.actionNeeded") as? Bool ?? true else {
      return
    }
    if #available(iOS 16.1, *), !Activity<BeebeebBackupActivityAttributes>.activities.isEmpty {
      UNUserNotificationCenter.current().removePendingNotificationRequests(
        withIdentifiers: [backupReminderIdentifier]
      )
      return
    }

    let now = Date()
    let lastSent = UserDefaults.standard.object(forKey: backupReminderLastSentKey) as? Date
    if let lastSent, now.timeIntervalSince(lastSent) < backupReminderCooldownSeconds {
      return
    }

    let content = UNMutableNotificationContent()
    content.title = "Open Beebeeb to continue backup"
    let label = payload.pending == 1 ? "1 photo is" : "\(payload.pending) photos are"
    content.body = "\(label) waiting to be encrypted and uploaded."
    content.sound = nil
    content.userInfo = [
      "url": "beebeeb://settings",
      "category": "backup_action_needed"
    ]

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: backupReminderDelaySeconds, repeats: false)
    let request = UNNotificationRequest(identifier: backupReminderIdentifier, content: content, trigger: trigger)
    UNUserNotificationCenter.current().add(request) { error in
      if let error {
        NSLog("[NativeBackupEngine] Failed to schedule open-app reminder: \(error.localizedDescription)")
      } else {
        UserDefaults.standard.set(now, forKey: backupReminderLastSentKey)
      }
    }
  }

  private func beginLiveActivityRequestIfIdle() -> Bool {
    liveActivityRequestQueue.sync {
      if liveActivityRequestInFlight {
        return false
      }
      liveActivityRequestInFlight = true
      return true
    }
  }

  private func finishLiveActivityRequest() {
    liveActivityRequestQueue.sync {
      liveActivityRequestInFlight = false
    }
  }

  private func updateLiveActivity(_ payload: BackupStatusPayload) {
    guard #available(iOS 16.1, *) else { return }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

    let contentState = BeebeebBackupActivityAttributes.ContentState(
      total: payload.total,
      completed: payload.completed,
      pending: payload.pending,
      waitingToEncrypt: payload.waitingToEncrypt,
      encryptedPendingUpload: payload.encryptedPendingUpload,
      uploading: payload.uploading,
      failed: payload.failed,
      state: payload.state,
      reason: payload.reason,
      updatedAt: Date()
    )

    Task {
      let activities = Activity<BeebeebBackupActivityAttributes>.activities
      let shouldKeepVisible = payload.pending > 0 || payload.inProgress > 0
      if shouldKeepVisible && payload.total > 0 {
        if let activity = activities.first {
          await activity.update(using: contentState)
          for extra in activities.dropFirst() {
            await extra.end(using: contentState, dismissalPolicy: .immediate)
          }
        } else {
          if !beginLiveActivityRequestIfIdle() {
            return
          }
          defer {
            finishLiveActivityRequest()
          }

          let recheckedActivities = Activity<BeebeebBackupActivityAttributes>.activities
          if let activity = recheckedActivities.first {
            await activity.update(using: contentState)
            for extra in recheckedActivities.dropFirst() {
              await extra.end(using: contentState, dismissalPolicy: .immediate)
            }
            return
          }

          do {
            _ = try Activity.request(
              attributes: BeebeebBackupActivityAttributes(startedAt: Date()),
              contentState: contentState,
              pushType: nil
            )
          } catch {
            NSLog("[NativeBackupEngine] Failed to start backup Live Activity: \(error.localizedDescription)")
          }
        }
      } else {
        for activity in activities {
          await activity.end(using: contentState, dismissalPolicy: .immediate)
        }
      }
    }
  }

  // MARK: - URLSession Setup

  private func setupBackgroundSession() {
    let config = URLSessionConfiguration.background(withIdentifier: Self.bgSessionIdentifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = true // Respect user's wifiOnly setting separately
    config.timeoutIntervalForResource = 60 * 60 // 1 hour for large files
    config.httpMaximumConnectionsPerHost = 3
    backgroundSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
  }

  private func setupMetadataSession() {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 60
    metadataSession = URLSession(configuration: config)
  }

  // MARK: - Lifecycle

  /// Start the backup engine. Loads the master key from keychain, registers
  /// the photo library observer, and begins draining the upload queue.
  func start() {
    if isRunning {
      wakeDrainLoop(reason: "start")
      return
    }

    do {
      guard let mk = try BeebeebCryptoBridge.loadMasterKey() else {
        NSLog("[NativeBackupEngine] No master key in keychain — cannot start")
        return
      }
      masterKeyHandle = mk
    } catch {
      NSLog("[NativeBackupEngine] Failed to load master key: \(error.localizedDescription)")
      return
    }

    guard token != nil, apiBaseUrl != nil else {
      NSLog("[NativeBackupEngine] Missing token or apiBaseUrl — cannot start")
      return
    }

    isRunning = true
    perfLog("start", [
      "total": totalAssets,
      "completed": completedAssets
    ])
    isPaused = false
    consecutiveFailures = 0
    backoffUntil = nil

    refreshProgress()
    registerPhotoObserver()
    startNetworkMonitor()
    wakeDrainLoop(reason: "start")
    updateBackupStatusSurfaces(reason: "Backup started")
    logDiagnosticSnapshot(reason: "start")

    NSLog("[NativeBackupEngine] Started — \(totalAssets) total, \(completedAssets) completed")
  }

  /// Stop the backup engine. Cancels the drain loop, unregisters observers,
  /// and clears the cached master key. In-flight NSURLSession background
  /// uploads continue independently.
  func stop() {
    guard isRunning else { return }
    isRunning = false
    isPaused = false

    drainTask?.cancel()
    drainTask = nil
    pendingDrainWakeReason = nil

    if photoObserverRegistered {
      PHPhotoLibrary.shared().unregisterChangeObserver(self)
      photoObserverRegistered = false
    }
    stopNetworkMonitor()

    // Clear sensitive state
    masterKeyHandle = nil
    uploadTaskMap.removeAll()

    // Recover any rows stuck in 'uploading' state
    dbQueue.async { [weak self] in
      self?.recoverStuckUploads()
    }
    endBackgroundGrace()

    perfLog("stop", [
      "total": totalAssets,
      "completed": completedAssets,
      "inProgress": inProgressAssets
    ])
    updateBackupStatusSurfaces(reason: "Backup stopped")
    logDiagnosticSnapshot(reason: "stop")
    scheduleOpenAppReminderIfNeeded()
    NSLog("[NativeBackupEngine] Stopped")
  }

  /// Pause the drain loop without clearing state. Background uploads continue.
  func pause() {
    isPaused = true
    perfLog("pause")
    updateBackupStatusSurfaces(reason: "Paused")
    logDiagnosticSnapshot(reason: "pause")
    NSLog("[NativeBackupEngine] Paused")
  }

  /// Resume after pause.
  func resume() {
    if !isRunning {
      start()
      guard isRunning else {
        updateBackupStatusSurfaces(reason: "Backup could not start")
        logDiagnosticSnapshot(reason: "resume_start_failed")
        return
      }
    }
    isPaused = false
    perfLog("resume")
    wakeDrainLoop(reason: "resume")
    updateBackupStatusSurfaces(reason: "Backup resumed")
    logDiagnosticSnapshot(reason: "resume")
    NSLog("[NativeBackupEngine] Resumed")
  }

  /// Return current progress as a dictionary suitable for JS bridge.
  func currentProgress() -> [String: Any] {
    refreshProgress()
    let pending = pendingUploadCount()
    let breakdown = backupWorkBreakdown()
    let state = backupState(pending: pending)
    return [
      "total": totalAssets,
      "completed": completedAssets,
      "pending": pending,
      "waitingToEncrypt": breakdown.waitingToEncrypt,
      "encryptedPendingUpload": breakdown.encryptedPendingUpload,
      "uploading": breakdown.uploading,
      "inProgress": inProgressAssets,
      "failed": failedAssets,
      "bytesUploaded": bytesUploaded,
      "bytesTotal": bytesTotal,
      "isRunning": isRunning,
      "isPaused": isPaused,
      "state": state.state,
      "reason": state.reason,
      "lastBackupAt": latestUploadedAt() ?? NSNull(),
    ]
  }

  // MARK: - Background task registration

  #if os(iOS)
  func registerBackgroundTask() {
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: Self.bgTaskIdentifier,
      using: nil
    ) { [weak self] task in
      guard let processingTask = task as? BGProcessingTask else { return }
      self?.handleBackgroundTask(processingTask)
    }
  }

  func scheduleNextBackup() {
    let request = BGProcessingTaskRequest(identifier: Self.bgTaskIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    try? BGTaskScheduler.shared.submit(request)
  }

  private func handleBackgroundTask(_ task: BGProcessingTask) {
    scheduleNextBackup()
    isBackgroundTaskActive = true

    task.expirationHandler = { [weak self] in
      self?.pause()
    }

    Task {
      defer {
        isBackgroundTaskActive = false
      }

      // Ensure master key is available for background processing
      if masterKeyHandle == nil {
        do {
          masterKeyHandle = try BeebeebCryptoBridge.loadMasterKey()
        } catch {
          task.setTaskCompleted(success: false)
          return
        }
      }

      guard masterKeyHandle != nil else {
        task.setTaskCompleted(success: false)
        return
      }

      let mode = currentPacingMode()
      perfLog("mode", [
        "mode": mode.rawValue,
        "batchLimit": mode.batchLimit,
        "delayMs": mode.delayNanoseconds / 1_000_000
      ])

      let batchStart = isRunning
      if !isRunning {
        isRunning = true
        isPaused = false
        updateBackupStatusSurfaces(reason: "Background backup running")
      }

      do {
        _ = await scanPhotoLibraryForPendingUploads(reason: "Background backup scan")
        let uploaded = try await processBatch(limit: mode.batchLimit)
        task.setTaskCompleted(success: uploaded >= 0)
      } catch {
        task.setTaskCompleted(success: false)
      }

      if !batchStart {
        isRunning = false
        updateBackupStatusSurfaces()
        scheduleOpenAppReminderIfNeeded()
      }
    }
  }
  #endif

  func handleBackgroundSessionEvents(identifier: String, completionHandler: @escaping () -> Void) {
    // iOS delivers pending delegate messages after relaunching the app.
    // Store the completion handler so we call it after all events are delivered.
    backgroundSessionCompletionHandler = completionHandler
  }

  private var backgroundSessionCompletionHandler: (() -> Void)?

  // MARK: - Photo Library Observer

  private func registerPhotoObserver() {
    if photoObserverRegistered {
      Task { [weak self] in
        guard let self else { return }
        if await self.scanPhotoLibraryForPendingUploads(reason: "Camera roll scanned") {
          self.wakeDrainLoop(reason: "photo-scan")
        }
      }
      return
    }

    photoObserverRegistered = true
    PHPhotoLibrary.shared().register(self)

    Task { [weak self] in
      guard let self else { return }
      if await self.scanPhotoLibraryForPendingUploads(reason: "Camera roll scanned") {
        self.wakeDrainLoop(reason: "photo-scan")
      }
    }
  }

  @discardableResult
  func scanPhotoLibraryForPendingUploads(reason: String) async -> Bool {
    let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    guard status == .authorized || status == .limited else {
      NSLog("[NativeBackupEngine] Photo library not authorized (status: \(status.rawValue))")
      return false
    }

    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    // Fetch both images and videos
    options.predicate = NSPredicate(format: "mediaType == %d OR mediaType == %d",
                                    PHAssetMediaType.image.rawValue,
                                    PHAssetMediaType.video.rawValue)
    let result = PHAsset.fetchAssets(with: options)
    currentFetchResult = result

    // Insert any new assets not yet in the database
    var assets: [PHAsset] = []
    result.enumerateObjects { asset, _, _ in assets.append(asset) }

    let hasPending = await withCheckedContinuation { continuation in
      dbQueue.async { [weak self] in
        guard let self else {
          continuation.resume(returning: false)
          return
        }
        self.insertNewAssets(assets)
        continuation.resume(returning: self.hasPendingUploads())
      }
    }

    DispatchQueue.main.async { [weak self] in
      self?.updateBackupStatusSurfaces(reason: reason)
    }
    return hasPending
  }

  // MARK: - Network Monitor

  private func startNetworkMonitor() {
    #if os(iOS)
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      let wasAvailable = self?.isNetworkAvailable ?? false
      self?.isNetworkAvailable = path.status == .satisfied

      // Resume drain loop when network comes back
      if !wasAvailable && path.status == .satisfied {
        NSLog("[NativeBackupEngine] Network restored — resuming")
        self?.isPaused = false
        self?.wakeDrainLoop(reason: "network")
      }
    }
    monitor.start(queue: queue)
    networkMonitor = monitor
    #endif
  }

  private func stopNetworkMonitor() {
    #if os(iOS)
    networkMonitor?.cancel()
    networkMonitor = nil
    #endif
  }

  // MARK: - Drain Loop

  private func currentApplicationState() -> UIApplication.State {
    if Thread.isMainThread {
      return UIApplication.shared.applicationState
    }

    return DispatchQueue.main.sync {
      UIApplication.shared.applicationState
    }
  }

  private func canExecuteBackupWorkNow() -> Bool {
    if isBackgroundTaskActive || isBackgroundGraceActive {
      return true
    }

    switch currentApplicationState() {
    case .active, .inactive:
      return true
    case .background:
      return false
    @unknown default:
      return false
    }
  }

  private func beginBackgroundGraceIfNeeded() {
    guard isRunning, !isPaused, pendingUploadCount() > 0 else { return }

    let begin: () -> Void = { [weak self] in
      guard let self, self.backgroundGraceTask == .invalid else { return }

      self.isBackgroundGraceActive = true
      self.backgroundGraceTask = UIApplication.shared.beginBackgroundTask(withName: "BeebeebBackupDrain") { [weak self] in
        guard let self else { return }
        self.endBackgroundGrace()
        self.updateBackupStatusSurfaces(reason: "Open Beebeeb to continue")
        self.scheduleOpenAppReminderIfNeeded()
      }

      if self.backgroundGraceTask == .invalid {
        self.isBackgroundGraceActive = false
      } else {
        self.wakeDrainLoop(reason: "background-grace")
      }
    }

    if Thread.isMainThread {
      begin()
    } else {
      DispatchQueue.main.async(execute: begin)
    }
  }

  private func endBackgroundGrace() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.backgroundGraceTask != .invalid else {
        self?.isBackgroundGraceActive = false
        return
      }
      let task = self.backgroundGraceTask
      self.backgroundGraceTask = .invalid
      self.isBackgroundGraceActive = false
      UIApplication.shared.endBackgroundTask(task)
    }
  }

  private func currentPacingMode() -> BackupPacingMode {
    if let backoff = backoffUntil, Date() < backoff {
      return .serverBackoff
    }

    let processInfo = ProcessInfo.processInfo
    if processInfo.isLowPowerModeEnabled {
      return .lowPower
    }

    switch processInfo.thermalState {
    case .serious, .critical:
      return .thermalPressure
    default:
      break
    }

    switch currentApplicationState() {
    case .active:
      return .foregroundActive
    case .background:
      return .background
    case .inactive:
      return .foregroundIdle
    @unknown default:
      return .foregroundActive
    }
  }

  private func sleepIfStillRunning(nanoseconds: UInt64) async -> Bool {
    guard isRunning, !Task.isCancelled else { return false }
    do {
      try await Task.sleep(nanoseconds: nanoseconds)
    } catch {
      return false
    }
    return isRunning && !Task.isCancelled
  }

  private func wakeDrainLoop(reason: String) {
    guard isRunning else { return }
    if drainTask != nil {
      pendingDrainWakeReason = reason
      return
    }
    startDrainLoop(reason: reason)
  }

  private func startDrainLoop(reason: String) {
    drainTask?.cancel()
    drainLoopGeneration += 1
    let generation = drainLoopGeneration
    perfLog("drain.wake", ["reason": reason])
    drainTask = Task { [weak self] in
      defer {
        if let self, self.drainLoopGeneration == generation {
          self.drainTask = nil
          if let reason = self.pendingDrainWakeReason, self.isRunning {
            self.pendingDrainWakeReason = nil
            self.wakeDrainLoop(reason: reason)
          }
        }
      }

      while let self, self.isRunning, !Task.isCancelled {
        if self.isPaused {
          _ = await self.sleepIfStillRunning(nanoseconds: 2_000_000_000) // 2s
          continue
        }

        let mode = self.currentPacingMode()
        self.perfLog("mode", [
          "mode": mode.rawValue,
          "batchLimit": mode.batchLimit,
          "delayMs": mode.delayNanoseconds / 1_000_000
        ])

        if let backoff = self.backoffUntil, Date() < backoff {
          let remaining = max(0, backoff.timeIntervalSinceNow)
          let delay = min(mode.delayNanoseconds, UInt64(remaining * 1_000_000_000))
          _ = await self.sleepIfStillRunning(nanoseconds: delay)
          continue
        }

        do {
          guard self.isRunning, !self.isPaused, !Task.isCancelled else { continue }
          self.dbQueue.sync { self.recoverStuckUploads() }
          guard self.dbQueue.sync(execute: { self.hasPendingUploads() }) else {
            return
          }

          let uploaded = try await self.processBatch(limit: mode.batchLimit)
          if uploaded == 0, !self.dbQueue.sync(execute: { self.hasPendingUploads() }) {
            return
          } else if uploaded == 0 {
            _ = await self.sleepIfStillRunning(nanoseconds: max(5_000_000_000, mode.delayNanoseconds)) // 5s on retry failures
          } else {
            _ = await self.sleepIfStillRunning(nanoseconds: mode.delayNanoseconds)
          }
        } catch {
          NSLog("[NativeBackupEngine] Batch error: \(error.localizedDescription)")
          _ = await self.sleepIfStillRunning(nanoseconds: max(5_000_000_000, mode.delayNanoseconds)) // 5s on error
        }
      }
    }
  }

  // MARK: - Core Upload Pipeline

  /// Process a batch of pending uploads. Returns the number of successfully uploaded assets.
  func processBatch(limit: Int = 12) async throws -> Int {
    guard isRunning, let masterKey = masterKeyHandle else { return 0 }
    guard let authToken = token, let baseURL = apiBaseUrl else {
      throw BackupError.notConfigured
    }

    if !beginBatchProcessing() {
      perfLog("batch.skip", ["reason": "already-processing", "limit": limit])
      return 0
    }
    defer { finishBatchProcessing() }

    // Recover stuck uploads on each batch start
    dbQueue.sync { recoverStuckUploads() }

    // Get pending assets from database
    let pending = dbQueue.sync { getPendingUploads(limit: limit) }
    if pending.isEmpty { return 0 }
    updateBackupStatusSurfaces(reason: "Preparing backup")

    perfLog("batch.start", [
      "limit": limit,
      "pending": pending.count,
      "running": isRunning
    ])

    let batchStart = Date()
    var uploaded = 0

    // Process with a foreground-friendly concurrency limit. The Rust uploader
    // can saturate bandwidth with multiple concurrent assets, which makes the
    // React Native UI and Files/Photos browsing feel sluggish.
    await withTaskGroup(of: Bool.self) { group in
      var activeCount = 0
      var index = 0

      while (index < pending.count || !group.isEmpty) && isRunning && !Task.isCancelled {
        // Add tasks up to concurrency limit
        while activeCount < maxConcurrentUploads && index < pending.count && isRunning && !Task.isCancelled {
          let asset = pending[index]
          index += 1
          activeCount += 1

          group.addTask { [weak self] in
            guard let self else { return false }
            return await self.uploadSingleAsset(
              asset,
              masterKey: masterKey,
              authToken: authToken,
              baseURL: baseURL
            )
          }
        }

        // Wait for one to complete
        if let result = await group.next() {
          activeCount -= 1
          if !self.isRunning || Task.isCancelled {
            group.cancelAll()
            break
          }
          if result {
            uploaded += 1
            self.consecutiveFailures = 0
          } else {
            self.consecutiveFailures += 1
            // 5 consecutive failures: 60s backoff
            if self.consecutiveFailures >= 5 {
              self.backoffUntil = Date().addingTimeInterval(60)
              NSLog("[NativeBackupEngine] 5 consecutive failures — backing off 60s")
            }
          }
        }
      }
    }

    let duration = Date().timeIntervalSince(batchStart)
    perfLog("batch.finish", [
      "uploaded": uploaded,
      "pending": pending.count,
      "durationMs": Int(duration * 1000)
    ])
    refreshProgress()

    onProgress?(totalAssets, completedAssets, failedAssets)
    onBatchComplete?(uploaded, pending.count - uploaded, duration)
    updateBackupStatusSurfaces()

    NSLog("[NativeBackupEngine] Batch complete: \(uploaded)/\(pending.count) uploaded in \(String(format: "%.1f", duration))s")

    #if os(iOS)
    // Update persistent notification
    if isRunning {
      updateNotification(
        uploaded: completedAssets,
        total: totalAssets,
        isComplete: pending.isEmpty && uploaded > 0,
        sessionUploaded: uploaded
      )
    }
    #endif

    return uploaded
  }

  /// Manual "Back up now" should give retry-exhausted rows another chance.
  /// Automatic background drains still respect the retry cap to avoid loops.
  func resetRetryExhaustedUploadsForManualRun() {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET retry_count = 0,
        error_message = NULL,
        last_attempt_at = NULL
    WHERE status IN ('pending_upload', 'pending_reupload')
      AND COALESCE(retry_count, 0) >= 10
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_step(stmt)
    let resetCount = sqlite3_changes(db)
    if resetCount > 0 {
      NSLog("[NativeBackupEngine] Reset \(resetCount) retry-exhausted uploads for manual backup")
    }
  }

  /// Manual "Back up now" should synchronously refresh the camera-roll index
  /// before attempting a batch. The normal observer scan is asynchronous, and
  /// a manual trigger can otherwise race ahead, see zero pending rows, and make
  /// the UI look active while no upload starts.
  func triggerManualBackup(limit: Int = 50) async throws -> [String: Any] {
    if !isRunning {
      start()
    } else {
      isPaused = false
      consecutiveFailures = 0
      backoffUntil = nil
    }

    guard isRunning else {
      throw BackupError.noMasterKey
    }

    resetRetryExhaustedUploadsForManualRun()
    let hasPending = await scanPhotoLibraryForPendingUploads(reason: "Manual backup scan")
    if hasPending || dbQueue.sync(execute: { hasPendingUploads() }) {
      wakeDrainLoop(reason: "manual-watch")
    }
    var progress = currentProgress()
    progress["batchUploaded"] = 0
    progress["manualTrigger"] = true
    return progress
  }

  // MARK: - Single Asset Upload

  private func uploadSingleAsset(
    _ asset: BackupAssetRow,
    masterKey: MasterKeyHandle,
    authToken: String,
    baseURL: String
  ) async -> Bool {
    guard isRunning && !Task.isCancelled else { return false }
    perfLog("asset.start", [
      "assetType": asset.assetType,
      "retry": asset.retryCount
    ])

    do {
      if let staged = dbQueue.sync(execute: { getStagedAsset(localAssetId: asset.localAssetId) }) {
        updateBackupStatusSurfaces(reason: "Uploading encrypted backup")
        return try await uploadStagedAsset(
          staged,
          authToken: authToken,
          baseURL: baseURL,
          masterKey: masterKey
        )
      }

      dbQueue.sync { markStaging(assetId: asset.localAssetId) }
      updateBackupStatusSurfaces(reason: "Encrypting backup")
      onFileStatus?(asset.localAssetId, "encrypting", nil, nil)

      guard isRunning && !Task.isCancelled else { return false }
      // 1. Get photo data from PHAsset
      let (data, uti) = try await fetchAssetData(localId: asset.localAssetId)
      guard canStageEncryptedAsset(plaintextBytes: Int64(data.count)) else {
        dbQueue.sync {
          markPending(assetId: asset.localAssetId, error: "Waiting for free iPhone storage before staging backup")
        }
        updateBackupStatusSurfaces(reason: "Waiting for iPhone storage")
        return false
      }
      guard isRunning && !Task.isCancelled else { return false }

      // 2. Generate file ID and derive file key
      let fileId = UUID().uuidString.lowercased()
      let fileKey = try masterKey.deriveFileKey(fileId: Data(fileId.utf8))
      guard isRunning && !Task.isCancelled else { return false }

      // 3. Encrypt chunks to temp files on disk for the Rust upload protocol
      let chunkResults = try encryptData(data: data, fileKey: fileKey)
      guard isRunning && !Task.isCancelled else { return false }
      let tempDir = NSTemporaryDirectory()
      var chunkPaths: [String] = []
      for (index, chunk) in chunkResults.enumerated() {
        var chunkData = Data()
        chunkData.append(chunk.nonce)
        chunkData.append(chunk.ciphertext)
        let path = (tempDir as NSString).appendingPathComponent("upload-\(fileId)-\(index).enc")
        try chunkData.write(to: URL(fileURLWithPath: path))
        chunkPaths.append(path)
      }
      defer {
        for path in chunkPaths {
          try? FileManager.default.removeItem(atPath: path)
        }
      }

      // 4. Encrypt filename
      let ext = fileExtension(for: uti)
      let filename = "IMG_\(fileId).\(ext)"
      let mimeType = mimeTypeFromUTI(uti)
      let nameEncrypted = try masterKey.encryptName(fileId: fileId, filename: filename, mimeType: mimeType)
      guard isRunning && !Task.isCancelled else { return false }

      let staged = try stageEncryptedAsset(
        asset: asset,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: mimeType,
        originalSize: data.count,
        chunkPaths: chunkPaths
      )
      chunkPaths.removeAll()
      updateBackupStatusSurfaces(reason: "Uploading encrypted backup")

      return try await uploadStagedAsset(
        staged,
        authToken: authToken,
        baseURL: baseURL,
        masterKey: masterKey
      )

    } catch BackupError.assetNotFound {
      perfLog("asset.missing", [
        "assetType": asset.assetType,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        markLocalMissing(assetId: asset.localAssetId)
      }
      refreshProgress()
      updateBackupStatusSurfaces(reason: "Skipped a photo no longer on this iPhone")

      onFileStatus?(asset.localAssetId, "local_missing", nil, BackupError.assetNotFound.localizedDescription)
      NSLog("[NativeBackupEngine] Asset missing locally, skipped: \(asset.localAssetId)")

      return false
    } catch {
      perfLog("asset.fail", [
        "assetType": asset.assetType,
        "retry": asset.retryCount
      ])
      dbQueue.sync {
        markFailed(assetId: asset.localAssetId, error: error.localizedDescription)
      }
      failedAssets += 1
      updateBackupStatusSurfaces(reason: "Upload failed")

      onFileStatus?(asset.localAssetId, "failed", nil, error.localizedDescription)
      NSLog("[NativeBackupEngine] Asset upload failed: \(error.localizedDescription)")

      return false
    }
  }

  // MARK: - Persistent Staging

  private func stagingRootDirectory() throws -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let root = base.appendingPathComponent(stagedBackupDirectoryName, isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  private func currentStagedDirectory(fileId: String) throws -> URL {
    try stagingRootDirectory().appendingPathComponent(fileId, isDirectory: true)
  }

  private func readableRegularFile(_ url: URL) -> Bool {
    guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
      return false
    }
    let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    return values?.isRegularFile == true && (values?.fileSize ?? 0) > 0
  }

  private func resolveStagedChunks(asset: BackupAssetRow, fileId: String) -> [StagedChunkRow]? {
    let currentDir: URL
    do {
      currentDir = try currentStagedDirectory(fileId: fileId)
    } catch {
      return nil
    }

    if asset.stagedDir != currentDir.path {
      dbQueue.sync {
        updateStagedDirectory(assetId: asset.localAssetId, stagedDir: currentDir.path)
      }
    }

    let chunks = dbQueue.sync { getPendingStagedChunks(assetId: asset.localAssetId) }
    var resolved: [StagedChunkRow] = []

    for chunk in chunks {
      let storedURL = URL(fileURLWithPath: chunk.path)
      if readableRegularFile(storedURL) {
        resolved.append(chunk)
        continue
      }

      let relocatedURL = currentDir.appendingPathComponent("\(chunk.index).enc")
      guard readableRegularFile(relocatedURL) else {
        NSLog("[NativeBackupEngine] Missing staged chunk \(chunk.index) for \(asset.localAssetId); clearing staged upload")
        return nil
      }

      dbQueue.sync {
        updateStagedChunkPath(
          assetId: asset.localAssetId,
          chunkIndex: chunk.index,
          path: relocatedURL.path
        )
      }
      resolved.append(StagedChunkRow(index: chunk.index, path: relocatedURL.path))
    }

    return resolved
  }

  private func currentAvailableBytes() -> Int64 {
    guard let url = try? stagingRootDirectory(),
          let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]),
          let available = values.volumeAvailableCapacityForImportantUsage else {
      return 0
    }
    return Int64(available)
  }

  private func stagedBytesOnDisk() -> Int64 {
    guard let root = try? stagingRootDirectory(),
          let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
          ) else { return 0 }

    var total: Int64 = 0
    for case let fileURL as URL in enumerator {
      let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
      total += Int64(size)
    }
    return total
  }

  private func estimatedEncryptedBytes(plaintextBytes: Int64) -> Int64 {
    let chunks = max(1, Int64(ceil(Double(plaintextBytes) / Double(chunkSize))))
    return plaintextBytes + (chunks * 64)
  }

  private func canStageEncryptedAsset(plaintextBytes: Int64) -> Bool {
    let needed = estimatedEncryptedBytes(plaintextBytes: plaintextBytes)
    let available = currentAvailableBytes()
    guard available > 0 else { return true }
    if available - needed < minimumFreeBytesAfterStaging {
      return false
    }
    return stagedBytesOnDisk() + needed <= maxStagedBackupBytes
  }

  private func stageEncryptedAsset(
    asset: BackupAssetRow,
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    originalSize: Int,
    chunkPaths: [String]
  ) throws -> BackupAssetRow {
    let root = try stagingRootDirectory()
    let dir = root.appendingPathComponent(fileId, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    var stagedPaths: [String] = []
    for (index, path) in chunkPaths.enumerated() {
      let destination = dir.appendingPathComponent("\(index).enc")
      if FileManager.default.fileExists(atPath: destination.path) {
        try FileManager.default.removeItem(at: destination)
      }
      try FileManager.default.moveItem(at: URL(fileURLWithPath: path), to: destination)
      stagedPaths.append(destination.path)
    }

    dbQueue.sync {
      markStaged(
        assetId: asset.localAssetId,
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: mimeType,
        isMediaValue: mediaFlag(assetType: asset.assetType, mimeType: mimeType),
        originalSize: Int64(originalSize),
        chunkCount: stagedPaths.count,
        stagedDir: dir.path
      )
      replaceStagedChunks(
        assetId: asset.localAssetId,
        fileId: fileId,
        chunkPaths: stagedPaths
      )
    }

    return dbQueue.sync {
      getStagedAsset(localAssetId: asset.localAssetId) ?? asset
    }
  }

  private func uploadStagedAsset(
    _ asset: BackupAssetRow,
    authToken: String,
    baseURL: String,
    masterKey: MasterKeyHandle
  ) async throws -> Bool {
    guard let fileId = asset.stagedFileId,
          let nameEncrypted = asset.stagedNameEncrypted,
          let stagedDir = asset.stagedDir else {
      dbQueue.sync { markPending(assetId: asset.localAssetId, error: "Missing staged backup metadata") }
      return false
    }

    guard let chunks = resolveStagedChunks(asset: asset, fileId: fileId) else {
      dbQueue.sync {
        clearStagedStateForRestage(
          assetId: asset.localAssetId,
          error: "Encrypted staging files moved or expired; re-encrypting"
        )
      }
      if let currentDir = try? currentStagedDirectory(fileId: fileId) {
        try? FileManager.default.removeItem(at: currentDir)
      }
      if stagedDir != (try? currentStagedDirectory(fileId: fileId).path) {
        try? FileManager.default.removeItem(atPath: stagedDir)
      }
      updateBackupStatusSurfaces(reason: "Re-encrypting backup")
      return false
    }

    let serverFileId: String
    let isResumingExistingRemote: Bool
    if let existing = asset.remoteFileId, !existing.isEmpty {
      serverFileId = existing
      isResumingExistingRemote = true
    } else {
      serverFileId = try await initUploadSession(
        fileId: fileId,
        nameEncrypted: nameEncrypted,
        mimeType: asset.stagedMimeType,
        isMedia: asset.stagedIsMedia,
        createdAt: asset.createdAt,
        sizeBytes: Int(asset.stagedOriginalSize),
        chunkCount: asset.stagedChunkCount,
        authToken: authToken,
        baseURL: baseURL
      )
      dbQueue.sync { markUploading(assetId: asset.localAssetId, remoteFileId: serverFileId) }
      isResumingExistingRemote = false
    }

    if isResumingExistingRemote {
      switch try await inspectExistingUpload(
        serverFileId: serverFileId,
        authToken: authToken,
        baseURL: baseURL
      ) {
      case .alreadyCompleted:
        dbQueue.sync {
          markUploadComplete(assetId: asset.localAssetId, remoteFileId: serverFileId)
          deleteStagedChunks(assetId: asset.localAssetId)
        }
        removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
        completedAssets += 1
        bytesUploaded += asset.stagedOriginalSize
        updateBackupStatusSurfaces(reason: "Recovered completed backup")
        onFileStatus?(asset.localAssetId, "uploaded", nil, nil)
        generateAndUploadThumbnail(
          phAssetId: asset.localAssetId,
          serverFileId: serverFileId,
          assetType: asset.assetType,
          mediaTypeHint: asset.stagedMimeType,
          masterKey: masterKey,
          authToken: authToken,
          baseURL: baseURL
        )
        return true

      case .missingRemote:
        dbQueue.sync {
          clearStagedStateForRestage(
            assetId: asset.localAssetId,
            error: "Remote upload session disappeared; re-encrypting"
          )
        }
        removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)
        updateBackupStatusSurfaces(reason: "Re-encrypting backup")
        return false

      case .resumable:
        dbQueue.sync { markUploading(assetId: asset.localAssetId, remoteFileId: serverFileId) }
      }
    }

    onFileStatus?(asset.localAssetId, "uploading", nil, nil)

    for chunk in chunks {
      guard isRunning && !Task.isCancelled else { return false }
      try await uploadStagedChunk(
        localAssetId: asset.localAssetId,
        serverFileId: serverFileId,
        chunkIndex: chunk.index,
        fileURL: URL(fileURLWithPath: chunk.path),
        authToken: authToken,
        baseURL: baseURL
      )
    }

    let remaining = dbQueue.sync { countPendingStagedChunks(assetId: asset.localAssetId) }
    guard remaining == 0 else { return false }

    try await completeUpload(
      serverFileId: serverFileId,
      authToken: authToken,
      baseURL: baseURL
    )

    dbQueue.sync {
      markUploadComplete(assetId: asset.localAssetId, remoteFileId: serverFileId)
      deleteStagedChunks(assetId: asset.localAssetId)
    }
    removeStagedDirectory(stagedDir: stagedDir, fileId: fileId)

    completedAssets += 1
    bytesUploaded += asset.stagedOriginalSize
    updateBackupStatusSurfaces()
    perfLog("asset.finish", [
      "bytes": asset.stagedOriginalSize,
      "chunks": asset.stagedChunkCount
    ])

    onFileStatus?(asset.localAssetId, "uploaded", nil, nil)
    NSLog("[NativeBackupEngine] Uploaded staged asset (\(asset.stagedOriginalSize) bytes, \(asset.stagedChunkCount) chunks)")

    generateAndUploadThumbnail(
      phAssetId: asset.localAssetId,
      serverFileId: serverFileId,
      assetType: asset.assetType,
      mediaTypeHint: asset.stagedMimeType,
      masterKey: masterKey,
      authToken: authToken,
      baseURL: baseURL
    )

    return true
  }

  private func removeStagedDirectory(stagedDir: String, fileId: String) {
    try? FileManager.default.removeItem(atPath: stagedDir)
    if let currentDir = try? currentStagedDirectory(fileId: fileId),
       stagedDir != currentDir.path {
      try? FileManager.default.removeItem(at: currentDir)
    }
  }

  private func inspectExistingUpload(
    serverFileId: String,
    authToken: String,
    baseURL: String
  ) async throws -> ExistingUploadDisposition {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/upload/status") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    if (200..<300).contains(statusCode) {
      return .resumable
    }

    if statusCode == 404 {
      return .missingRemote
    }

    let body = String(data: data, encoding: .utf8) ?? ""
    if statusCode == 400, body.localizedCaseInsensitiveContains("upload already completed") {
      return .alreadyCompleted
    }

    if statusCode == 429 {
      if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
         let seconds = Double(retryAfter) {
        backoffUntil = Date().addingTimeInterval(seconds)
      } else {
        backoffUntil = Date().addingTimeInterval(60)
      }
      throw BackupError.httpStatus(429, "Rate limited")
    }

    throw BackupError.httpStatus(statusCode, body)
  }

  private func uploadStagedChunk(
    localAssetId: String,
    serverFileId: String,
    chunkIndex: Int,
    fileURL: URL,
    authToken: String,
    baseURL: String
  ) async throws {
    guard fileURL.isFileURL,
          FileManager.default.isReadableFile(atPath: fileURL.path) else {
      throw BackupError.assetLoadFailed
    }

    guard let url = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/chunks/\(chunkIndex)") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

    let description = BackgroundChunkTaskDescription(
      localAssetId: localAssetId,
      serverFileId: serverFileId,
      chunkIndex: chunkIndex
    )

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let task = backgroundSession.uploadTask(with: request, fromFile: fileURL)
      if let data = try? JSONEncoder().encode(description),
         let encoded = String(data: data, encoding: .utf8) {
        task.taskDescription = encoded
      }
      chunkUploadContinuations[task.taskIdentifier] = continuation
      dbQueue.async { [weak self] in
        self?.markChunkUploading(assetId: localAssetId, chunkIndex: chunkIndex, taskId: task.taskIdentifier)
      }
      task.resume()
    }
  }

  // MARK: - Encryption

  /// Encrypt data into chunks using the existing FileKeyHandle.encryptChunk API.
  /// Returns an array of EncryptedData (nonce + ciphertext per chunk).
  private func encryptData(data: Data, fileKey: FileKeyHandle) throws -> [EncryptedData] {
    var results: [EncryptedData] = []
    let totalChunks = max(1, Int(ceil(Double(data.count) / Double(chunkSize))))

    for i in 0..<totalChunks {
      let start = i * chunkSize
      let end = min(start + chunkSize, data.count)
      let chunkPlaintext = start < end ? data.subdata(in: start..<end) : Data()
      let encrypted = try fileKey.encryptChunk(plaintext: chunkPlaintext)
      results.append(encrypted)
    }

    return results
  }

  // MARK: - PHAsset Data Fetch

  private func fetchAssetData(localId: String) async throws -> (Data, String) {
    let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [localId], options: nil)
    guard let phAsset = fetchResult.firstObject else {
      throw BackupError.assetNotFound
    }

    if phAsset.mediaType == .video {
      return try await fetchVideoData(phAsset: phAsset)
    }

    return try await withCheckedThrowingContinuation { continuation in
      let options = PHImageRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      options.deliveryMode = .highQualityFormat

      PHImageManager.default().requestImageDataAndOrientation(for: phAsset, options: options) { data, uti, _, info in
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let data = data {
          continuation.resume(returning: (data, uti ?? "public.jpeg"))
        } else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
        }
      }
    }
  }

  private func fetchVideoData(phAsset: PHAsset) async throws -> (Data, String) {
    return try await withCheckedThrowingContinuation { continuation in
      let options = PHVideoRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true

      PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { avAsset, _, info in
        guard let urlAsset = avAsset as? AVURLAsset else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
          return
        }

        do {
          let data = try Data(contentsOf: urlAsset.url)
          let uti = urlAsset.url.pathExtension == "mov" ? "com.apple.quicktime-movie" : "public.mpeg-4"
          continuation.resume(returning: (data, uti))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  // MARK: - API Calls (metadata session — standard URLSession, not background)

  private func initUploadSession(
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    isMedia: Bool,
    createdAt: String,
    sizeBytes: Int,
    chunkCount: Int,
    authToken: String,
    baseURL: String
  ) async throws -> String {
    guard let url = URL(string: "\(baseURL)/api/v1/files/upload/init") else {
      throw BackupError.invalidServerURL
    }

    let body: [String: Any] = [
      "file_id": fileId,
      "name_encrypted": nameEncrypted,
      "parent_id": parentFolderId as Any? ?? NSNull(),
      "mime_type": NSNull(),
      "is_media": isMedia,
      "created_at": normalizedCreatedAt(createdAt),
      "size_bytes": sizeBytes,
      "chunk_count": chunkCount,
    ]
    guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
      throw BackupError.jsonEncoding
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = bodyData

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    // Handle rate limiting
    if statusCode == 429 {
      if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
         let seconds = Double(retryAfter) {
        backoffUntil = Date().addingTimeInterval(seconds)
      } else {
        backoffUntil = Date().addingTimeInterval(60)
      }
      throw BackupError.httpStatus(429, "Rate limited")
    }

    guard (200..<300).contains(statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw BackupError.httpStatus(statusCode, body)
    }

    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let serverFileId = json["file_id"] as? String,
          !serverFileId.isEmpty else {
      throw BackupError.invalidResponse
    }

    return serverFileId
  }

  private func uploadChunk(
    serverFileId: String,
    chunkIndex: Int,
    chunkData: Data,
    authToken: String,
    baseURL: String
  ) async throws {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/chunks/\(chunkIndex)") else {
      throw BackupError.invalidServerURL
    }

    // Write chunk to temp file for background-safe upload
    let tempDir = NSTemporaryDirectory()
    let tempFile = URL(fileURLWithPath: tempDir).appendingPathComponent("chunk-\(serverFileId)-\(chunkIndex).enc")
    try chunkData.write(to: tempFile)
    defer { try? FileManager.default.removeItem(at: tempFile) }

    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

    // Use uploadTask(with:fromFile:) for background-safe transfer.
    // For now we await the result synchronously within the TaskGroup.
    // The background session handles retries and survives app suspension.
    let (_, response) = try await backgroundSession.upload(for: request, fromFile: tempFile)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    if statusCode == 429 {
      if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
         let seconds = Double(retryAfter) {
        backoffUntil = Date().addingTimeInterval(seconds)
      }
      throw BackupError.httpStatus(429, "Rate limited")
    }

    guard (200..<300).contains(statusCode) else {
      throw BackupError.httpStatus(statusCode, "Chunk upload failed")
    }
  }

  private func completeUpload(
    serverFileId: String,
    authToken: String,
    baseURL: String
  ) async throws {
    guard let url = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/upload/complete") else {
      throw BackupError.invalidServerURL
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
    request.httpBody = Data("{}".utf8)

    let (data, response) = try await metadataSession.data(for: request)
    let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

    guard (200..<300).contains(statusCode) else {
      let body = String(data: data, encoding: .utf8) ?? ""
      throw BackupError.httpStatus(statusCode, body)
    }
  }

  // MARK: - SQLite Database

  /// Open the same database that React Native reads for backup insights.
  /// expo-sqlite stores databases in <documentDir>/SQLite/<name>.
  private func openDatabase() {
    let documentDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    let sqliteDir = documentDir.appendingPathComponent("SQLite", isDirectory: true)
    try? FileManager.default.createDirectory(at: sqliteDir, withIntermediateDirectories: true)
    let path = sqliteDir.appendingPathComponent("beebeeb-backup.db").path

    let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
      NSLog("[NativeBackupEngine] Failed to open database at \(path)")
      db = nil
      return
    }

    // Enable WAL mode for concurrent access with JS layer
    sqlite3_exec(db, "PRAGMA journal_mode = WAL", nil, nil, nil)

    // Ensure tables exist (safe to call even if JS already created them)
    ensureTables()
  }

  private func ensureTables() {
    guard let db = db else { return }

    let sql = """
    CREATE TABLE IF NOT EXISTS backup_assets (
      local_asset_id TEXT PRIMARY KEY,
      remote_file_id TEXT,
      remote_path TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      uploaded_at TEXT,
      asset_type TEXT NOT NULL,
      status TEXT NOT NULL,
      queued_at INTEGER,
      last_attempt_at INTEGER,
      retry_count INTEGER DEFAULT 0,
      error_message TEXT,
      staged_file_id TEXT,
      staged_name_encrypted TEXT,
      staged_mime_type TEXT,
      staged_is_media INTEGER DEFAULT 0,
      staged_original_size INTEGER DEFAULT 0,
      staged_chunk_count INTEGER DEFAULT 0,
      staged_dir TEXT,
      staged_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS backup_upload_chunks (
      local_asset_id TEXT NOT NULL,
      server_file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      task_id INTEGER,
      last_error TEXT,
      uploaded_at INTEGER,
      PRIMARY KEY(local_asset_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_backup_assets_status_type
      ON backup_assets(status, asset_type);
    CREATE INDEX IF NOT EXISTS idx_backup_assets_created_at
      ON backup_assets(created_at);
    CREATE INDEX IF NOT EXISTS idx_backup_upload_chunks_asset_status
      ON backup_upload_chunks(local_asset_id, status);
    """
    sqlite3_exec(db, sql, nil, nil, nil)

    let migrations = [
      "ALTER TABLE backup_assets ADD COLUMN staged_file_id TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_name_encrypted TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_mime_type TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_is_media INTEGER DEFAULT 0",
      "ALTER TABLE backup_assets ADD COLUMN staged_original_size INTEGER DEFAULT 0",
      "ALTER TABLE backup_assets ADD COLUMN staged_chunk_count INTEGER DEFAULT 0",
      "ALTER TABLE backup_assets ADD COLUMN staged_dir TEXT",
      "ALTER TABLE backup_assets ADD COLUMN staged_at INTEGER",
    ]
    for migration in migrations {
      sqlite3_exec(db, migration, nil, nil, nil)
    }

    migratePhotoKitMissingAssetRows()
  }

  private func migratePhotoKitMissingAssetRows() {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = 'local_missing',
        retry_count = 0,
        error_message = 'Photo removed from this iPhone before backup completed',
        last_attempt_at = ?
    WHERE status != 'uploaded'
      AND (
        error_message LIKE '%Photo asset not found%'
        OR error_message LIKE '%not found in library%'
      )
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, nowMs())
    sqlite3_step(stmt)
    let changed = sqlite3_changes(db)
    if changed > 0 {
      NSLog("[NativeBackupEngine] Moved \(changed) missing PhotoKit asset rows to local_missing")
    }
  }

  /// Insert new assets from the photo library that are not already tracked.
  private func insertNewAssets(_ assets: [PHAsset]) {
    guard let db = db else { return }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    let sql = """
    INSERT INTO backup_assets
      (local_asset_id, content_hash, file_size, created_at, asset_type, status, queued_at)
    VALUES (?, '', 0, ?, ?, 'pending_upload', ?)
    ON CONFLICT(local_asset_id) DO UPDATE SET
      created_at = excluded.created_at,
      asset_type = excluded.asset_type,
      status = CASE
        WHEN backup_assets.status = 'local_missing' THEN 'pending_upload'
        ELSE backup_assets.status
      END,
      retry_count = CASE
        WHEN backup_assets.status = 'local_missing' THEN 0
        ELSE COALESCE(backup_assets.retry_count, 0)
      END,
      error_message = CASE
        WHEN backup_assets.status = 'local_missing' THEN NULL
        ELSE backup_assets.error_message
      END
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }

    sqlite3_exec(db, "BEGIN", nil, nil, nil)
    for asset in assets {
      let assetType: String = asset.mediaType == .video ? "video" : "photo"
      let createdAt = isoString(from: asset.creationDate ?? Date())

      sqlite3_bind_text(stmt, 1, (asset.localIdentifier as NSString).utf8String, -1, transient)
      sqlite3_bind_text(stmt, 2, (createdAt as NSString).utf8String, -1, transient)
      sqlite3_bind_text(stmt, 3, (assetType as NSString).utf8String, -1, transient)
      sqlite3_bind_int64(stmt, 4, nowMs)
      sqlite3_step(stmt)
      sqlite3_reset(stmt)
    }
    sqlite3_exec(db, "COMMIT", nil, nil, nil)
  }

  /// Get pending uploads ordered by creation date (newest first), respecting retry limits.
  func getPendingUploads(limit: Int) -> [BackupAssetRow] {
    guard let db = db else { return [] }
    var results: [BackupAssetRow] = []

    let sql = """
    SELECT local_asset_id, remote_file_id, asset_type, content_hash, file_size, created_at,
           COALESCE(retry_count, 0), error_message,
           staged_file_id, staged_name_encrypted, staged_mime_type,
           COALESCE(staged_is_media, 0), COALESCE(staged_original_size, 0),
           COALESCE(staged_chunk_count, 0), staged_dir
    FROM backup_assets
    WHERE status IN ('pending_upload', 'pending_reupload', 'staged_upload', 'uploading')
      AND COALESCE(retry_count, 0) < 10
    ORDER BY created_at DESC
    LIMIT ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int(stmt, 1, Int32(limit))

    while sqlite3_step(stmt) == SQLITE_ROW {
      results.append(backupAssetRow(from: stmt))
    }

    return results
  }

  private func backupAssetRow(from stmt: OpaquePointer?) -> BackupAssetRow {
    let localAssetId = String(cString: sqlite3_column_text(stmt, 0))
    let remoteFileId: String? = sqlite3_column_type(stmt, 1) != SQLITE_NULL
      ? String(cString: sqlite3_column_text(stmt, 1))
      : nil
    let assetType = String(cString: sqlite3_column_text(stmt, 2))
    let contentHash = String(cString: sqlite3_column_text(stmt, 3))
    let fileSize = sqlite3_column_int64(stmt, 4)
    let createdAt = String(cString: sqlite3_column_text(stmt, 5))
    let retryCount = Int(sqlite3_column_int(stmt, 6))
    let errorMsg: String? = sqlite3_column_type(stmt, 7) != SQLITE_NULL
      ? String(cString: sqlite3_column_text(stmt, 7))
      : nil
    let stagedFileId: String? = sqlite3_column_type(stmt, 8) != SQLITE_NULL
      ? String(cString: sqlite3_column_text(stmt, 8))
      : nil
    let stagedNameEncrypted: String? = sqlite3_column_type(stmt, 9) != SQLITE_NULL
      ? String(cString: sqlite3_column_text(stmt, 9))
      : nil
    let stagedMimeType: String? = sqlite3_column_type(stmt, 10) != SQLITE_NULL
      ? String(cString: sqlite3_column_text(stmt, 10))
      : nil

    return BackupAssetRow(
      localAssetId: localAssetId,
      remoteFileId: remoteFileId,
      assetType: assetType,
      contentHash: contentHash,
      fileSize: fileSize,
      createdAt: createdAt,
      retryCount: retryCount,
      errorMessage: errorMsg,
      filename: nil,
      stagedFileId: stagedFileId,
      stagedNameEncrypted: stagedNameEncrypted,
      stagedMimeType: stagedMimeType,
      stagedIsMedia: sqlite3_column_int(stmt, 11) != 0,
      stagedOriginalSize: sqlite3_column_int64(stmt, 12),
      stagedChunkCount: Int(sqlite3_column_int(stmt, 13)),
      stagedDir: sqlite3_column_type(stmt, 14) != SQLITE_NULL
        ? String(cString: sqlite3_column_text(stmt, 14))
        : nil
    )
  }

  private func getStagedAsset(localAssetId: String) -> BackupAssetRow? {
    guard let db = db else { return nil }
    let sql = """
    SELECT local_asset_id, remote_file_id, asset_type, content_hash, file_size, created_at,
           COALESCE(retry_count, 0), error_message,
           staged_file_id, staged_name_encrypted, staged_mime_type,
           COALESCE(staged_is_media, 0), COALESCE(staged_original_size, 0),
           COALESCE(staged_chunk_count, 0), staged_dir
    FROM backup_assets
    WHERE local_asset_id = ?
      AND staged_file_id IS NOT NULL
      AND staged_dir IS NOT NULL
    LIMIT 1
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (localAssetId as NSString).utf8String, -1, nil)
    guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
    return backupAssetRow(from: stmt)
  }

  private func hasPendingUploads() -> Bool {
    guard let db = db else { return false }
    let sql = """
    SELECT 1
    FROM backup_assets
    WHERE status IN ('pending_upload', 'pending_reupload', 'staged_upload', 'uploading')
      AND COALESCE(retry_count, 0) < 10
    LIMIT 1
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return false }
    defer { sqlite3_finalize(stmt) }
    return sqlite3_step(stmt) == SQLITE_ROW
  }

  /// Mark an asset as currently uploading.
  private func markUploading(assetId: String) {
    guard let db = db else { return }
    let nowMs = nowMs()
    let sql = "UPDATE backup_assets SET status = 'uploading', last_attempt_at = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, nowMs)
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func markUploading(assetId: String, remoteFileId: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = 'uploading',
        remote_file_id = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (remoteFileId as NSString).utf8String, -1, nil)
    sqlite3_bind_int64(stmt, 2, nowMs())
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func markStaging(assetId: String) {
    guard let db = db else { return }
    let sql = "UPDATE backup_assets SET status = 'staging', last_attempt_at = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, nowMs())
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func markPending(assetId: String, error: String?) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = CASE WHEN staged_file_id IS NOT NULL THEN 'staged_upload' ELSE 'pending_upload' END,
        error_message = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    if let error {
      sqlite3_bind_text(stmt, 1, (error as NSString).utf8String, -1, nil)
    } else {
      sqlite3_bind_null(stmt, 1)
    }
    sqlite3_bind_int64(stmt, 2, nowMs())
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func markStaged(
    assetId: String,
    fileId: String,
    nameEncrypted: String,
    mimeType: String?,
    isMediaValue: Bool,
    originalSize: Int64,
    chunkCount: Int,
    stagedDir: String
  ) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = 'staged_upload',
        staged_file_id = ?,
        staged_name_encrypted = ?,
        staged_mime_type = ?,
        staged_is_media = ?,
        staged_original_size = ?,
        staged_chunk_count = ?,
        staged_dir = ?,
        staged_at = ?,
        file_size = ?,
        error_message = NULL
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (fileId as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 2, (nameEncrypted as NSString).utf8String, -1, nil)
    if let mimeType {
      sqlite3_bind_text(stmt, 3, (mimeType as NSString).utf8String, -1, nil)
    } else {
      sqlite3_bind_null(stmt, 3)
    }
    sqlite3_bind_int(stmt, 4, isMediaValue ? 1 : 0)
    sqlite3_bind_int64(stmt, 5, originalSize)
    sqlite3_bind_int(stmt, 6, Int32(chunkCount))
    sqlite3_bind_text(stmt, 7, (stagedDir as NSString).utf8String, -1, nil)
    sqlite3_bind_int64(stmt, 8, nowMs())
    sqlite3_bind_int64(stmt, 9, originalSize)
    sqlite3_bind_text(stmt, 10, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func updateStagedDirectory(assetId: String, stagedDir: String) {
    guard let db = db else { return }
    let sql = "UPDATE backup_assets SET staged_dir = ? WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (stagedDir as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func clearStagedStateForRestage(assetId: String, error: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = 'pending_reupload',
        remote_file_id = NULL,
        staged_file_id = NULL,
        staged_name_encrypted = NULL,
        staged_mime_type = NULL,
        staged_is_media = 0,
        staged_original_size = 0,
        staged_chunk_count = 0,
        staged_dir = NULL,
        staged_at = NULL,
        error_message = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (error as NSString).utf8String, -1, nil)
    sqlite3_bind_int64(stmt, 2, nowMs())
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
    deleteStagedChunks(assetId: assetId)
  }

  /// Mark an asset as successfully uploaded.
  private func markUploadComplete(assetId: String, remoteFileId: String) {
    guard let db = db else { return }
    let now = ISO8601DateFormatter().string(from: Date())
    let sql = """
    UPDATE backup_assets
    SET status = 'uploaded',
        remote_file_id = ?,
        uploaded_at = ?,
        error_message = NULL,
        retry_count = 0,
        staged_file_id = NULL,
        staged_name_encrypted = NULL,
        staged_mime_type = NULL,
        staged_is_media = 0,
        staged_original_size = 0,
        staged_chunk_count = 0,
        staged_dir = NULL,
        staged_at = NULL
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (remoteFileId as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 2, (now as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  /// Mark an asset as failed, incrementing retry count.
  private func markFailed(assetId: String, error: String) {
    guard let db = db else { return }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    // Increment retry_count. Assets with retry_count >= 10 become dead letters.
    let sql = """
    UPDATE backup_assets
    SET status = CASE WHEN staged_file_id IS NOT NULL THEN 'staged_upload' ELSE 'pending_upload' END,
        retry_count = COALESCE(retry_count, 0) + 1,
        error_message = ?,
        last_attempt_at = ?
    WHERE local_asset_id = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (error as NSString).utf8String, -1, nil)
    sqlite3_bind_int64(stmt, 2, nowMs)
    sqlite3_bind_text(stmt, 3, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func markLocalMissing(assetId: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_assets
    SET status = 'local_missing',
        retry_count = 0,
        error_message = 'Photo removed from this iPhone before backup completed',
        last_attempt_at = ?
    WHERE local_asset_id = ?
      AND status != 'uploaded'
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, nowMs())
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  private func replaceStagedChunks(assetId: String, fileId: String, chunkPaths: [String]) {
    guard let db = db else { return }
    var deleteStmt: OpaquePointer?
    if sqlite3_prepare_v2(db, "DELETE FROM backup_upload_chunks WHERE local_asset_id = ?", -1, &deleteStmt, nil) == SQLITE_OK {
      sqlite3_bind_text(deleteStmt, 1, (assetId as NSString).utf8String, -1, nil)
      sqlite3_step(deleteStmt)
    }
    sqlite3_finalize(deleteStmt)

    let sql = """
    INSERT INTO backup_upload_chunks
      (local_asset_id, server_file_id, chunk_index, path, status)
    VALUES (?, ?, ?, ?, 'pending')
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_exec(db, "BEGIN", nil, nil, nil)
    for (index, path) in chunkPaths.enumerated() {
      sqlite3_bind_text(stmt, 1, (assetId as NSString).utf8String, -1, nil)
      sqlite3_bind_text(stmt, 2, (fileId as NSString).utf8String, -1, nil)
      sqlite3_bind_int(stmt, 3, Int32(index))
      sqlite3_bind_text(stmt, 4, (path as NSString).utf8String, -1, nil)
      sqlite3_step(stmt)
      sqlite3_reset(stmt)
    }
    sqlite3_exec(db, "COMMIT", nil, nil, nil)
  }

  private func getPendingStagedChunks(assetId: String) -> [StagedChunkRow] {
    guard let db = db else { return [] }
    let sql = """
    SELECT chunk_index, path
    FROM backup_upload_chunks
    WHERE local_asset_id = ?
      AND status != 'uploaded'
    ORDER BY chunk_index ASC
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (assetId as NSString).utf8String, -1, nil)
    var chunks: [StagedChunkRow] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      chunks.append(StagedChunkRow(
        index: Int(sqlite3_column_int(stmt, 0)),
        path: String(cString: sqlite3_column_text(stmt, 1))
      ))
    }
    return chunks
  }

  private func updateStagedChunkPath(assetId: String, chunkIndex: Int, path: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET path = ?
    WHERE local_asset_id = ? AND chunk_index = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (path as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    sqlite3_step(stmt)
  }

  private func countPendingStagedChunks(assetId: String) -> Int {
    guard let db = db else { return 0 }
    var stmt: OpaquePointer?
    let sql = """
    SELECT COUNT(*)
    FROM backup_upload_chunks
    WHERE local_asset_id = ?
      AND status != 'uploaded'
    """
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (assetId as NSString).utf8String, -1, nil)
    return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
  }

  private func markChunkUploading(assetId: String, chunkIndex: Int, taskId: Int) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET status = 'uploading', task_id = ?, last_error = NULL
    WHERE local_asset_id = ? AND chunk_index = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int(stmt, 1, Int32(taskId))
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    sqlite3_step(stmt)
  }

  private func markChunkUploaded(assetId: String, chunkIndex: Int) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET status = 'uploaded', uploaded_at = ?, last_error = NULL
    WHERE local_asset_id = ? AND chunk_index = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, nowMs())
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    sqlite3_step(stmt)
  }

  private func markChunkFailed(assetId: String, chunkIndex: Int, error: String) {
    guard let db = db else { return }
    let sql = """
    UPDATE backup_upload_chunks
    SET status = 'pending', task_id = NULL, last_error = ?
    WHERE local_asset_id = ? AND chunk_index = ?
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (error as NSString).utf8String, -1, nil)
    sqlite3_bind_text(stmt, 2, (assetId as NSString).utf8String, -1, nil)
    sqlite3_bind_int(stmt, 3, Int32(chunkIndex))
    sqlite3_step(stmt)
  }

  private func deleteStagedChunks(assetId: String) {
    guard let db = db else { return }
    let sql = "DELETE FROM backup_upload_chunks WHERE local_asset_id = ?"
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_text(stmt, 1, (assetId as NSString).utf8String, -1, nil)
    sqlite3_step(stmt)
  }

  /// Recover assets stuck in 'uploading' state for more than 5 minutes.
  /// This handles crashes or app terminations mid-upload.
  func recoverStuckUploads() {
    guard let db = db else { return }
    let fiveMinAgoMs = Int64((Date().timeIntervalSince1970 - 300) * 1000)
    let sql = """
    UPDATE backup_assets
    SET status = CASE WHEN staged_file_id IS NOT NULL THEN 'staged_upload' ELSE 'pending_upload' END
    WHERE status IN ('uploading', 'staging')
      AND (last_attempt_at IS NULL OR last_attempt_at < ?)
    """
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return }
    defer { sqlite3_finalize(stmt) }
    sqlite3_bind_int64(stmt, 1, fiveMinAgoMs)
    sqlite3_step(stmt)

    let changes = sqlite3_changes(db)
    if changes > 0 {
      NSLog("[NativeBackupEngine] Recovered \(changes) stuck uploads")
    }

    sqlite3_exec(db, "UPDATE backup_upload_chunks SET status = 'pending', task_id = NULL WHERE status = 'uploading'", nil, nil, nil)
  }

  /// Refresh progress counters from the database.
  private func refreshProgress() {
    dbQueue.sync {
      guard let db = db else { return }
      migratePhotoKitMissingAssetRows()
      totalAssets = countWhere(db: db, condition: "1=1")
      completedAssets = countWhere(db: db, condition: "status = 'uploaded'")
      failedAssets = countWhere(db: db, condition: "COALESCE(retry_count, 0) >= 10")
      inProgressAssets = countWhere(db: db, condition: "status IN ('staging', 'staged_upload', 'uploading')")
    }
  }

  private func countWhere(db: OpaquePointer, condition: String) -> Int {
    var stmt: OpaquePointer?
    let sql = "SELECT COUNT(*) FROM backup_assets WHERE \(condition)"
    guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return 0 }
    defer { sqlite3_finalize(stmt) }
    return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
  }

  // MARK: - Notification

  #if os(iOS)
  private func updateNotification(uploaded _: Int, total _: Int, isComplete: Bool, sessionUploaded: Int) {
    DispatchQueue.main.async {
      if UIApplication.shared.applicationState == .active {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
        return
      }

      let content = UNMutableNotificationContent()
      content.title = "Beebeeb Backup"
      guard isComplete else { return }
      guard UserDefaults.standard.object(forKey: "io.beebeeb.backupNotifications.backupSummaries") as? Bool ?? true else {
        return
      }
      guard sessionUploaded > 0 else { return }
      let label = sessionUploaded == 1 ? "1 new photo" : "\(sessionUploaded) new photos"
      content.body = "Beebeeb backed up \(label) in the last 24 hours"
      content.sound = nil

      let request = UNNotificationRequest(
        identifier: "io.beebeeb.backup-progress",
        content: content,
        trigger: nil
      )
      UNUserNotificationCenter.current().add(request) { _ in }

      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(
          withIdentifiers: ["io.beebeeb.backup-progress"]
        )
      }
    }
  }
  #endif

  // MARK: - Thumbnail Generation

  /// Maximum dimension for generated thumbnails (matches JS THUMB_WIDTH).
  private let thumbMaxSize = 768
  private let thumbTargetBytes = 50 * 1024
  private let thumbMaxEncryptedBytes = 64 * 1024
  private let thumbEncryptionOverheadBytes = 28
  private let thumbWebPVariants: [(maxDimension: CGFloat, quality: CGFloat)] = [
    (768, 0.82),
    (768, 0.74),
    (768, 0.66),
    (768, 0.58),
    (768, 0.50),
    (640, 0.58),
    (512, 0.58),
    (384, 0.56),
  ]

  private func resizeForThumbnail(_ image: UIImage, maxDimension: CGFloat) -> UIImage? {
    let longestSide = max(image.size.width, image.size.height)
    guard longestSide > maxDimension else { return image }
    let scale = maxDimension / longestSide
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: size))
    }
  }

  private func encodeWebP(_ image: UIImage, quality: CGFloat) -> Data? {
    let options: [SDImageCoderOption: Any] = [
      .encodeCompressionQuality: quality,
      .encodeFirstFrameOnly: true,
    ]
    return SDImageWebPCoder.shared.encodedData(
      with: image,
      format: .webP,
      options: options
    ) as Data?
  }

  private func encodeAdaptiveThumbnailWebP(_ image: UIImage) -> Data? {
    var fallback: Data?
    let maxPlaintextBytes = thumbMaxEncryptedBytes - thumbEncryptionOverheadBytes
    for variant in thumbWebPVariants {
      guard let resized = resizeForThumbnail(image, maxDimension: variant.maxDimension),
            let data = encodeWebP(resized, quality: variant.quality)
      else { continue }
      if data.count <= maxPlaintextBytes {
        fallback = data
      }
      if data.count <= thumbTargetBytes {
        return data
      }
    }
    return fallback
  }

  /// Generate and upload a thumbnail for an uploaded asset.
  /// Best-effort: failures are logged but never block the upload pipeline.
  private func generateAndUploadThumbnail(
    phAssetId: String,
    serverFileId: String,
    assetType: String,
    mediaTypeHint: String?,
    masterKey: MasterKeyHandle,
    authToken: String,
    baseURL: String
  ) {
    Task.detached(priority: .utility) { [weak self] in
      guard let self else { return }
      do {
        let thumbnailData: Data
        if assetType == "video" || self.isVideoType(mediaTypeHint) {
          thumbnailData = try await self.generateVideoThumbnail(phAssetId: phAssetId)
        } else {
          thumbnailData = try await self.generateImageThumbnail(phAssetId: phAssetId)
        }

        // Encrypt thumbnail as single AES-256-GCM chunk
        let fileKey = try masterKey.deriveFileKey(fileId: Data(serverFileId.utf8))
        let enc = try fileKey.encryptChunk(plaintext: thumbnailData)

        // Wire format: nonce(12) || ciphertext — matches the web client
        var wire = Data(capacity: enc.nonce.count + enc.ciphertext.count)
        wire.append(enc.nonce)
        wire.append(enc.ciphertext)
        guard wire.count <= self.thumbMaxEncryptedBytes else {
          NSLog("[NativeBackupEngine] Thumbnail skipped: encrypted payload too large (\(wire.count) bytes)")
          return
        }

        // Upload via PUT
        guard let thumbUrl = URL(string: "\(baseURL)/api/v1/files/\(serverFileId)/thumbnail") else { return }
        var request = URLRequest(url: thumbUrl)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = wire

        let (_, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(statusCode) {
          NSLog("[NativeBackupEngine] Thumbnail uploaded")
        } else {
          NSLog("[NativeBackupEngine] Thumbnail upload HTTP \(statusCode)")
        }
      } catch {
        NSLog("[NativeBackupEngine] Thumbnail generation failed: \(error.localizedDescription)")
      }
    }
  }

  /// Generate a WebP thumbnail from a video asset using AVAssetImageGenerator.
  private func generateVideoThumbnail(phAssetId: String) async throws -> Data {
    let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [phAssetId], options: nil).firstObject
    guard let phAsset else { throw BackupError.assetNotFound }

    let avAsset: AVAsset = try await withCheckedThrowingContinuation { continuation in
      let options = PHVideoRequestOptions()
      options.version = .original
      options.isNetworkAccessAllowed = true
      PHImageManager.default().requestAVAsset(forVideo: phAsset, options: options) { asset, _, info in
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let asset {
          continuation.resume(returning: asset)
        } else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
        }
      }
    }

    let generator = AVAssetImageGenerator(asset: avAsset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: thumbMaxSize, height: thumbMaxSize)

    let time = CMTime(seconds: 1.0, preferredTimescale: 600)
    let cgImage: CGImage
    do {
      cgImage = try generator.copyCGImage(at: time, actualTime: nil)
    } catch {
      // Fall back to time 0 if 1s is beyond the video duration
      cgImage = try generator.copyCGImage(at: .zero, actualTime: nil)
    }

    let image = UIImage(cgImage: cgImage)
    guard let webp = encodeAdaptiveThumbnailWebP(image) else {
      throw BackupError.assetLoadFailed
    }
    return webp
  }

  /// Generate a WebP thumbnail from an image asset (JPEG, HEIC, PNG, DNG, etc).
  /// Uses PHImageManager to get a small preview — this works for all image types
  /// including RAW/DNG because Photos.framework handles the decoding.
  private func generateImageThumbnail(phAssetId: String) async throws -> Data {
    let phAsset = PHAsset.fetchAssets(withLocalIdentifiers: [phAssetId], options: nil).firstObject
    guard let phAsset else { throw BackupError.assetNotFound }

    let image: UIImage = try await withCheckedThrowingContinuation { continuation in
      let options = PHImageRequestOptions()
      options.deliveryMode = .highQualityFormat
      options.isNetworkAccessAllowed = true
      options.isSynchronous = false
      options.resizeMode = .fast

      let targetSize = CGSize(width: thumbMaxSize, height: thumbMaxSize)
      PHImageManager.default().requestImage(
        for: phAsset,
        targetSize: targetSize,
        contentMode: .aspectFit,
        options: options
      ) { result, info in
        let isDegraded = info?[PHImageResultIsDegradedKey] as? Bool ?? false
        if isDegraded { return } // Wait for the high-quality callback
        if let error = info?[PHImageErrorKey] as? Error {
          continuation.resume(throwing: error)
        } else if let result {
          continuation.resume(returning: result)
        } else {
          continuation.resume(throwing: BackupError.assetLoadFailed)
        }
      }
    }

    guard let webp = encodeAdaptiveThumbnailWebP(image) else {
      throw BackupError.assetLoadFailed
    }
    return webp
  }

  /// Whether the given UTI represents a video type.
  private func isVideoType(_ value: String?) -> Bool {
    guard let value = value?.lowercased() else { return false }
    return value.hasPrefix("video/") ||
           value == "com.apple.quicktime-movie" ||
           value == "public.mpeg-4" ||
           value.hasPrefix("public.movie") ||
           value.hasPrefix("public.video")
  }

  private func mediaFlag(assetType: String, mimeType: String?) -> Bool {
    if assetType == "photo" || assetType == "video" {
      return true
    }
    guard let mimeType = mimeType?.lowercased() else {
      return false
    }
    return mimeType.hasPrefix("image/") || mimeType.hasPrefix("video/")
  }

  // MARK: - MIME / Extension Helpers

  private func mimeTypeFromUTI(_ uti: String) -> String? {
    let map: [String: String] = [
      "public.jpeg": "image/jpeg",
      "public.png": "image/png",
      "public.heic": "image/heic",
      "public.heif": "image/heif",
      "public.tiff": "image/tiff",
      "com.adobe.raw-image": "image/x-adobe-dng",
      "com.apple.quicktime-movie": "video/quicktime",
      "public.mpeg-4": "video/mp4",
    ]
    if let mimeType = map[uti] {
      return mimeType
    }
    return UTType(uti)?.preferredMIMEType
  }

  private func fileExtension(for uti: String) -> String {
    let map: [String: String] = [
      "public.jpeg": "jpg",
      "public.png": "png",
      "public.heic": "heic",
      "public.heif": "heif",
      "public.tiff": "tiff",
      "com.adobe.raw-image": "dng",
      "com.apple.quicktime-movie": "mov",
      "public.mpeg-4": "mp4",
    ]
    return map[uti] ?? "bin"
  }
}

// MARK: - PHPhotoLibraryChangeObserver

extension NativeBackupEngine: PHPhotoLibraryChangeObserver {
  func photoLibraryDidChange(_ changeInstance: PHChange) {
    guard let old = currentFetchResult else { return }
    guard let details = changeInstance.changeDetails(for: old) else { return }

    currentFetchResult = details.fetchResultAfterChanges
    let inserted = details.insertedObjects
    if !inserted.isEmpty {
      dbQueue.async { [weak self] in
        guard let self else { return }
        self.insertNewAssets(inserted)
        if self.hasPendingUploads() {
          self.wakeDrainLoop(reason: "photo-library")
        }
        DispatchQueue.main.async {
          self.updateBackupStatusSurfaces(reason: "New photos detected")
        }
      }
      NSLog("[NativeBackupEngine] Detected \(inserted.count) new assets in photo library")
    }
  }
}

// MARK: - URLSessionDelegate

extension NativeBackupEngine: URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let description = task.taskDescription,
       let data = description.data(using: .utf8),
       let chunk = try? JSONDecoder().decode(BackgroundChunkTaskDescription.self, from: data) {
      let statusCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
      let continuation = chunkUploadContinuations.removeValue(forKey: task.taskIdentifier)

      if let error {
        dbQueue.async { [weak self] in
          self?.markChunkFailed(
            assetId: chunk.localAssetId,
            chunkIndex: chunk.chunkIndex,
            error: error.localizedDescription
          )
        }
        continuation?.resume(throwing: error)
      } else if (200..<300).contains(statusCode) {
        dbQueue.async { [weak self] in
          guard let self else { return }
          self.markChunkUploaded(assetId: chunk.localAssetId, chunkIndex: chunk.chunkIndex)
          DispatchQueue.main.async {
            self.updateBackupStatusSurfaces()
            self.wakeDrainLoop(reason: "background-chunk")
          }
        }
        continuation?.resume()
      } else {
        let uploadError = BackupError.httpStatus(statusCode, "Chunk upload failed")
        dbQueue.async { [weak self] in
          self?.markChunkFailed(
            assetId: chunk.localAssetId,
            chunkIndex: chunk.chunkIndex,
            error: "HTTP \(statusCode)"
          )
        }
        continuation?.resume(throwing: uploadError)
      }
      return
    }

    // Handle background upload completion for tasks tracked in uploadTaskMap
    guard let localAssetId = uploadTaskMap[task.taskIdentifier] else { return }
    uploadTaskMap.removeValue(forKey: task.taskIdentifier)

    dbQueue.async { [weak self] in
      guard let self, self.db != nil else { return }
      if let error = error {
        self.markFailed(assetId: localAssetId, error: error.localizedDescription)
      } else {
        let statusCode = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(statusCode) {
          // Background chunk upload succeeded — handled by the await in uploadChunk
        } else {
          self.markFailed(assetId: localAssetId, error: "HTTP \(statusCode)")
        }
      }
      DispatchQueue.main.async {
        self.updateBackupStatusSurfaces()
      }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    DispatchQueue.main.async { [weak self] in
      self?.backgroundSessionCompletionHandler?()
      self?.backgroundSessionCompletionHandler = nil
    }
  }
}
